package main

import (
	"bytes"
	"compress/gzip"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"mime"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"cosmossdk.io/log/v2"

	crypto_tedwards "github.com/consensys/gnark-crypto/ecc/bn254/twistededwards"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/backend/witness"
	"github.com/consensys/gnark/constraint"

	clairveiltypes "github.com/DELIGHT-LABS/clairveil/types"
	privacydeposit "github.com/DELIGHT-LABS/clairveil/x/privacy/client/sdk/deposit"
	privacyfield "github.com/DELIGHT-LABS/clairveil/x/privacy/client/sdk/field"
	privacycrypto "github.com/DELIGHT-LABS/clairveil/x/privacy/crypto"
	privacytypes "github.com/DELIGHT-LABS/clairveil/x/privacy/types"
	privacyzk "github.com/DELIGHT-LABS/clairveil/x/privacy/zk"
)

const (
	depositProofPath       = "/v1/prover/deposit"
	healthPath             = "/healthz"
	depositProtocolVersion = "v1"
	defaultListenAddress   = "127.0.0.1:8090"
	defaultMaxRequestBytes = int64(64 << 10)
	maxHeaderBytes         = 1 << 20
)

type depositProofRequest struct {
	Version string               `json:"version"`
	Payload depositProverPayload `json:"payload"`
}

type depositProverPayload struct {
	Version                string `json:"version"`
	ReceiverSpendPubKeyHex string `json:"receiver_spend_pubkey_hex"`
	ReceiverViewPubKeyHex  string `json:"receiver_view_pubkey_hex"`
	Amount                 string `json:"amount"`
	AssetIDHex             string `json:"asset_id_hex"`
	RandomnessHex          string `json:"randomness_hex"`
	NoteCommitmentHex      string `json:"note_commitment_hex"`
}

type preparedDepositProof struct {
	Version           string `json:"version"`
	NoteCommitmentHex string `json:"note_commitment_hex"`
	ProofHex          string `json:"proof_hex"`
}

type depositProofResponse struct {
	Version string               `json:"version"`
	Proof   preparedDepositProof `json:"proof"`
}

type errorResponse struct {
	Version   string `json:"version"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable,omitempty"`
}

type noteProver interface {
	ProveDeposit(privacytypes.Note) ([]byte, error)
}

type referenceNoteProver struct{}

type depositArtifactProvider struct{}

type depositProofRunner struct{}

type depositProofHandler struct {
	prover          noteProver
	maxRequestBytes int64
	proofSlot       chan struct{}
}

func configureSDK() {
	clairveiltypes.SetConfig()
}

func (referenceNoteProver) ProveDeposit(note privacytypes.Note) ([]byte, error) {
	return privacydeposit.BuildDepositProof(note, depositArtifactProvider{}, depositProofRunner{})
}

func (depositArtifactProvider) DepositR1CS() (constraint.ConstraintSystem, error) {
	return privacyzk.GetDepositR1CS()
}

func (depositArtifactProvider) DepositProvingKey() (groth16.ProvingKey, error) {
	return privacyzk.GetDepositProvingKey()
}

func (depositProofRunner) ProveDeposit(r1cs constraint.ConstraintSystem, provingKey groth16.ProvingKey, depositWitness witness.Witness) (groth16.Proof, error) {
	return groth16.Prove(r1cs, provingKey, depositWitness)
}

func newDepositProofHandler(prover noteProver, maxRequestBytes int64) (http.Handler, error) {
	if prover == nil {
		return nil, fmt.Errorf("deposit prover is required")
	}
	if maxRequestBytes <= 0 {
		return nil, fmt.Errorf("max request bytes must be positive")
	}

	handler := &depositProofHandler{
		prover:          prover,
		maxRequestBytes: maxRequestBytes,
		proofSlot:       make(chan struct{}, 1),
	}
	return handler, nil
}

func (h *depositProofHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case exactRequestPath(r, healthPath):
		h.handleHealth(w, r)
	case exactRequestPath(r, depositProofPath):
		h.handleProof(w, r)
	default:
		h.handleNotFound(w, r)
	}
}

func exactRequestPath(r *http.Request, expected string) bool {
	return r != nil && r.URL != nil && r.URL.Path == expected && r.URL.EscapedPath() == expected
}

func (h *depositProofHandler) handleNotFound(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, "not_found", "prover transport route not found")
}

func (h *depositProofHandler) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "health endpoint requires GET")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"version": "v1", "status": "ok"})
}

func (h *depositProofHandler) handleProof(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "deposit proof endpoint requires POST")
		return
	}
	if err := validateProofRequestMediaType(r.Header.Get("Content-Type")); err != nil {
		writeError(w, http.StatusUnsupportedMediaType, "invalid_request", "Content-Type must be application/json")
		return
	}

	body, tooLarge, err := readProofRequestBody(w, r, h.maxRequestBytes)
	if err != nil {
		if tooLarge {
			writeError(w, http.StatusRequestEntityTooLarge, "invalid_request", "deposit proof request is too large")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid_request", "failed to read deposit proof request")
		return
	}

	var request depositProofRequest
	if err := decodeStrictJSON(body, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid deposit proof request")
		return
	}
	note, computedCommitment, err := noteFromDepositProofRequest(request)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "deposit proof request validation failed")
		return
	}

	if r.Context().Err() != nil {
		return
	}
	select {
	case h.proofSlot <- struct{}{}:
		defer func() { <-h.proofSlot }()
	case <-r.Context().Done():
		return
	default:
		writeError(w, http.StatusTooManyRequests, "busy", "deposit prover is busy")
		return
	}

	proof, err := h.prover.ProveDeposit(*note)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "proof_failed", "deposit proof generation failed")
		return
	}
	if err := privacyzk.ValidateCanonicalProofBN254(proof); err != nil {
		writeError(w, http.StatusInternalServerError, "proof_failed", "deposit proof response validation failed")
		return
	}
	writeJSON(w, http.StatusOK, depositProofResponse{
		Version: depositProtocolVersion,
		Proof: preparedDepositProof{
			Version:           depositProtocolVersion,
			ProofHex:          hex.EncodeToString(proof),
			NoteCommitmentHex: computedCommitment,
		},
	})
}

func decodeStrictJSON(payload []byte, target any) error {
	if err := rejectDuplicateJSONKeys(payload); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}

func rejectDuplicateJSONKeys(payload []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	var walkValue func() error
	walkValue = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := make(map[string]struct{})
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return fmt.Errorf("JSON object key must be a string")
				}
				if _, exists := seen[key]; exists {
					return fmt.Errorf("duplicate JSON object key %q", key)
				}
				seen[key] = struct{}{}
				if err := walkValue(); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil {
				return err
			}
			if closing != json.Delim('}') {
				return fmt.Errorf("invalid JSON object framing")
			}
		case '[':
			for decoder.More() {
				if err := walkValue(); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil {
				return err
			}
			if closing != json.Delim(']') {
				return fmt.Errorf("invalid JSON array framing")
			}
		default:
			return fmt.Errorf("invalid JSON delimiter")
		}
		return nil
	}
	if err := walkValue(); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}

func validateProofRequestMediaType(value string) error {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	mediaType, params, err := mime.ParseMediaType(value)
	if err != nil || !strings.EqualFold(mediaType, "application/json") {
		return fmt.Errorf("unsupported content type")
	}
	if len(params) == 0 {
		return nil
	}
	if len(params) != 1 {
		return fmt.Errorf("unsupported content type parameters")
	}
	for name, parameter := range params {
		if !strings.EqualFold(name, "charset") || !strings.EqualFold(parameter, "utf-8") {
			return fmt.Errorf("unsupported content type parameters")
		}
	}
	return nil
}

func readProofRequestBody(w http.ResponseWriter, r *http.Request, maxRequestBytes int64) ([]byte, bool, error) {
	contentEncoding, err := proofRequestContentEncoding(r.Header.Values("Content-Encoding"))
	if err != nil {
		return nil, false, err
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		var maxBytesError *http.MaxBytesError
		return nil, errors.As(err, &maxBytesError), err
	}
	if contentEncoding == "identity" {
		return raw, false, nil
	}
	reader, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, false, err
	}
	decompressed, err := io.ReadAll(io.LimitReader(reader, maxRequestBytes+1))
	closeErr := reader.Close()
	if err != nil {
		return nil, false, err
	}
	if closeErr != nil {
		return nil, false, closeErr
	}
	if int64(len(decompressed)) > maxRequestBytes {
		return nil, true, fmt.Errorf("decompressed request exceeds limit")
	}
	return decompressed, false, nil
}

func proofRequestContentEncoding(values []string) (string, error) {
	if len(values) == 0 {
		return "identity", nil
	}
	if len(values) != 1 {
		return "", fmt.Errorf("multiple content encodings are not supported")
	}
	value := strings.TrimSpace(values[0])
	if value == "" || strings.Contains(value, ",") {
		return "", fmt.Errorf("invalid content encoding")
	}
	switch strings.ToLower(value) {
	case "identity", "gzip":
		return strings.ToLower(value), nil
	default:
		return "", fmt.Errorf("unsupported content encoding")
	}
}

func noteFromDepositProofRequest(request depositProofRequest) (*privacytypes.Note, string, error) {
	if request.Version != depositProtocolVersion || request.Payload.Version != depositProtocolVersion {
		return nil, "", fmt.Errorf("unsupported deposit proof version")
	}
	spendKey, err := decodeDepositPublicKey(request.Payload.ReceiverSpendPubKeyHex, "receiver spend public key")
	if err != nil {
		return nil, "", err
	}
	viewKey, err := decodeDepositPublicKey(request.Payload.ReceiverViewPubKeyHex, "receiver view public key")
	if err != nil {
		return nil, "", err
	}
	amount, err := privacytypes.ParseCanonicalShieldedAmount("deposit prover payload amount", request.Payload.Amount)
	if err != nil {
		return nil, "", err
	}
	assetID, err := decodeDepositField(request.Payload.AssetIDHex, "asset id")
	if err != nil {
		return nil, "", err
	}
	randomness, err := decodeDepositField(request.Payload.RandomnessHex, "randomness")
	if err != nil {
		return nil, "", err
	}
	commitment, err := decodeDepositField(request.Payload.NoteCommitmentHex, "note commitment")
	if err != nil {
		return nil, "", err
	}
	if commitment.Sign() == 0 {
		return nil, "", fmt.Errorf("deposit note commitment must be non-zero")
	}

	note := &privacytypes.Note{
		ReceiverSpendPubKeyX: spendKey.X.BigInt(new(big.Int)),
		ReceiverSpendPubKeyY: spendKey.Y.BigInt(new(big.Int)),
		ReceiverViewPubKeyX:  viewKey.X.BigInt(new(big.Int)),
		ReceiverViewPubKeyY:  viewKey.Y.BigInt(new(big.Int)),
		Amount:               amount,
		AssetID:              assetID,
		Randomness:           randomness,
		Memo:                 "",
	}
	if err := note.ValidateV1(); err != nil {
		return nil, "", fmt.Errorf("invalid deposit prover payload NoteV1: %w", err)
	}
	if note.ComputeCommitment().Cmp(commitment) != 0 {
		return nil, "", fmt.Errorf("deposit prover payload note commitment mismatch")
	}
	computedCommitment, err := privacyfield.CanonicalHexFromBigInt(note.ComputeCommitment())
	if err != nil {
		return nil, "", err
	}
	return note, computedCommitment, nil
}

func decodeDepositPublicKey(value, label string) (*crypto_tedwards.PointAffine, error) {
	encoded, err := decodeExactLowerHex(value, privacycrypto.CanonicalPointSize, label)
	if err != nil {
		return nil, err
	}
	point, err := privacycrypto.DecodeCanonicalPoint(encoded)
	if err != nil {
		return nil, fmt.Errorf("invalid %s: %w", label, err)
	}
	return point, nil
}

func decodeDepositField(value, label string) (*big.Int, error) {
	if _, err := decodeExactLowerHex(value, privacyfield.ByteSize, label); err != nil {
		return nil, err
	}
	encoded, err := privacyfield.DecodeCanonicalHex(value, label)
	if err != nil {
		return nil, err
	}
	return new(big.Int).SetBytes(encoded), nil
}

func decodeExactLowerHex(value string, size int, label string) ([]byte, error) {
	if len(value) != size*2 {
		return nil, fmt.Errorf("%s must be exactly %d lowercase hex characters", label, size*2)
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return nil, fmt.Errorf("%s must be exactly %d lowercase hex characters", label, size*2)
		}
	}
	encoded, err := hex.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("invalid %s hex: %w", label, err)
	}
	return encoded, nil
}

func writeError(w http.ResponseWriter, statusCode int, code, message string) {
	writeJSON(w, statusCode, errorResponse{
		Version:   depositProtocolVersion,
		Code:      code,
		Message:   message,
		Retryable: code == "busy",
	})
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func validateListenAddress(address string) error {
	host, _, err := net.SplitHostPort(strings.TrimSpace(address))
	if err != nil {
		return fmt.Errorf("invalid listen address: %w", err)
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("deposit prover must listen on a loopback address")
	}
	return nil
}

func main() {
	configureSDK()

	listenAddress := defaultListenAddress
	maxRequestBytes := defaultMaxRequestBytes
	flag.StringVar(&listenAddress, "listen", listenAddress, "loopback listen address for the local deposit prover")
	flag.Int64Var(&maxRequestBytes, "max-request-bytes", maxRequestBytes, "maximum accepted JSON request body size in bytes")
	flag.Parse()
	if err := validateListenAddress(listenAddress); err != nil {
		fmt.Fprintf(os.Stderr, "invalid local deposit prover configuration: %v\n", err)
		os.Exit(1)
	}

	logger := log.NewLogger(os.Stderr)
	if err := privacyzk.RunProverPreflight(logger, []privacyzk.CircuitID{privacyzk.CircuitDeposit}); err != nil {
		fmt.Fprintf(os.Stderr, "local deposit prover preflight failed: %v\n", err)
		os.Exit(1)
	}
	handler, err := newDepositProofHandler(referenceNoteProver{}, maxRequestBytes)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to build local deposit prover: %v\n", err)
		os.Exit(1)
	}
	server := &http.Server{
		Addr:              listenAddress,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    maxHeaderBytes,
	}

	fmt.Fprintf(os.Stderr, "local deposit prover listening on %s\n", listenAddress)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintf(os.Stderr, "local deposit prover stopped with error: %v\n", err)
		os.Exit(1)
	}
}
