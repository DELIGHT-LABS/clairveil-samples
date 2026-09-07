package main

import (
	"bytes"
	"compress/gzip"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	crypto_tedwards "github.com/consensys/gnark-crypto/ecc/bn254/twistededwards"
	"github.com/stretchr/testify/require"

	privacyfield "github.com/DELIGHT-LABS/clairveil/x/privacy/client/sdk/field"
	privacyidentity "github.com/DELIGHT-LABS/clairveil/x/privacy/client/sdk/identity"
	privacytypes "github.com/DELIGHT-LABS/clairveil/x/privacy/types"
	privacyzk "github.com/DELIGHT-LABS/clairveil/x/privacy/zk"
)

const canonicalGeneratorGroth16ProofHex = "8000000000000000000000000000000000000000000000000000000000000001" +
	"998e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c" +
	"21800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed" +
	"8000000000000000000000000000000000000000000000000000000000000001" +
	"00000000" +
	"8000000000000000000000000000000000000000000000000000000000000001"

type recordingNoteProver struct {
	calls int
	note  privacytypes.Note
	proof []byte
	err   error
}

type blockingNoteProver struct {
	proof   []byte
	started chan struct{}
	release chan struct{}
}

func (p *recordingNoteProver) ProveDeposit(note privacytypes.Note) ([]byte, error) {
	p.calls++
	p.note = note
	return p.proof, p.err
}

func (p *blockingNoteProver) ProveDeposit(privacytypes.Note) ([]byte, error) {
	close(p.started)
	<-p.release
	return p.proof, nil
}

func TestDepositProofHandlerReturnsCanonicalV1Contract(t *testing.T) {
	note := validTestNote(t)
	requestBody := marshalDepositRequest(t, depositRequestForNote(t, note))
	proof := canonicalTestProof(t)
	prover := &recordingNoteProver{proof: proof}
	handler, err := newDepositProofHandler(prover, defaultMaxRequestBytes)
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, depositProofPath, bytes.NewReader(requestBody))
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	handler.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "application/json", recorder.Header().Get("Content-Type"))
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
	require.Equal(t, 1, prover.calls)
	require.Zero(t, prover.note.Amount.Cmp(note.Amount))
	require.Empty(t, prover.note.Memo)

	commitment, err := privacyfield.CanonicalHexFromBigInt(note.ComputeCommitment())
	require.NoError(t, err)
	var response depositProofResponse
	require.NoError(t, decodeStrictJSON(recorder.Body.Bytes(), &response))
	require.Equal(t, depositProtocolVersion, response.Version)
	require.Equal(t, depositProtocolVersion, response.Proof.Version)
	require.Equal(t, commitment, response.Proof.NoteCommitmentHex)
	require.Equal(t, hex.EncodeToString(proof), response.Proof.ProofHex)
}

func TestDepositProofHandlerAcceptsCanonicalGzipRequest(t *testing.T) {
	requestBody := marshalDepositRequest(t, depositRequestForNote(t, validTestNote(t)))
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, err := writer.Write(requestBody)
	require.NoError(t, err)
	require.NoError(t, writer.Close())

	prover := &recordingNoteProver{proof: canonicalTestProof(t)}
	handler, err := newDepositProofHandler(prover, defaultMaxRequestBytes)
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, depositProofPath, bytes.NewReader(compressed.Bytes()))
	request.Header.Set("Content-Encoding", "gzip")
	handler.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, 1, prover.calls)
}

func TestDepositProofHandlerReturnsCanonicalBusyError(t *testing.T) {
	requestBody := marshalDepositRequest(t, depositRequestForNote(t, validTestNote(t)))
	prover := &blockingNoteProver{
		proof:   canonicalTestProof(t),
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	handler, err := newDepositProofHandler(prover, defaultMaxRequestBytes)
	require.NoError(t, err)

	firstStatus := make(chan int, 1)
	go func() {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, depositProofPath, bytes.NewReader(requestBody))
		handler.ServeHTTP(recorder, request)
		firstStatus <- recorder.Code
	}()
	<-prover.started

	secondRecorder := httptest.NewRecorder()
	secondRequest := httptest.NewRequest(http.MethodPost, depositProofPath, bytes.NewReader(requestBody))
	handler.ServeHTTP(secondRecorder, secondRequest)
	assertCanonicalError(t, secondRecorder, http.StatusTooManyRequests, "busy", true)

	close(prover.release)
	require.Equal(t, http.StatusOK, <-firstStatus)
}

func TestDepositProofHandlerRejectsInvalidCanonicalRequestBeforeProving(t *testing.T) {
	base := depositRequestForNote(t, validTestNote(t))
	tests := []struct {
		name    string
		request depositProofRequest
	}{
		{
			name: "request version",
			request: func() depositProofRequest {
				value := base
				value.Version = "v2"
				return value
			}(),
		},
		{
			name: "payload version",
			request: func() depositProofRequest {
				value := base
				value.Payload.Version = "v2"
				return value
			}(),
		},
		{
			name: "uppercase key hex",
			request: func() depositProofRequest {
				value := base
				value.Payload.ReceiverSpendPubKeyHex = strings.ToUpper(value.Payload.ReceiverSpendPubKeyHex)
				return value
			}(),
		},
		{
			name: "non canonical amount",
			request: func() depositProofRequest {
				value := base
				value.Payload.Amount = "07"
				return value
			}(),
		},
		{
			name: "mismatched commitment",
			request: func() depositProofRequest {
				value := base
				value.Payload.NoteCommitmentHex = strings.Repeat("00", privacyfield.ByteSize)
				return value
			}(),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			prover := &recordingNoteProver{proof: canonicalTestProof(t)}
			handler, err := newDepositProofHandler(prover, defaultMaxRequestBytes)
			require.NoError(t, err)
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, depositProofPath, bytes.NewReader(marshalDepositRequest(t, test.request)))
			request.Header.Set("Content-Type", "application/json")
			handler.ServeHTTP(recorder, request)

			assertCanonicalError(t, recorder, http.StatusBadRequest, "invalid_request", false)
			require.Zero(t, prover.calls)
		})
	}
}

func TestDepositProofHandlerRejectsLegacyAndNonStrictJSON(t *testing.T) {
	canonical := string(marshalDepositRequest(t, depositRequestForNote(t, validTestNote(t))))
	tests := []struct {
		name string
		body string
	}{
		{name: "legacy flat wire", body: `{"note_json":"{}","note_commitment_hex":"` + strings.Repeat("00", 32) + `"}`},
		{name: "unknown field", body: strings.TrimSuffix(canonical, "}") + `,"unexpected":true}`},
		{name: "duplicate field", body: strings.TrimSuffix(canonical, "}") + `,"version":"v1"}`},
		{name: "trailing JSON", body: canonical + `{}`},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			prover := &recordingNoteProver{proof: canonicalTestProof(t)}
			handler, err := newDepositProofHandler(prover, defaultMaxRequestBytes)
			require.NoError(t, err)
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, depositProofPath, strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			handler.ServeHTTP(recorder, request)

			assertCanonicalError(t, recorder, http.StatusBadRequest, "invalid_request", false)
			require.Zero(t, prover.calls)
		})
	}
}

func TestDepositProofHandlerRejectsInvalidGeneratedProof(t *testing.T) {
	handler, err := newDepositProofHandler(&recordingNoteProver{proof: []byte{0xaa}}, defaultMaxRequestBytes)
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		depositProofPath,
		bytes.NewReader(marshalDepositRequest(t, depositRequestForNote(t, validTestNote(t)))),
	)
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(recorder, request)

	assertCanonicalError(t, recorder, http.StatusInternalServerError, "proof_failed", false)
}

func TestDepositProofHandlerReturnsCanonicalTransportErrors(t *testing.T) {
	prover := &recordingNoteProver{proof: canonicalTestProof(t)}
	handler, err := newDepositProofHandler(prover, 8)
	require.NoError(t, err)

	tests := []struct {
		name            string
		path            string
		method          string
		contentType     string
		contentEncoding string
		body            string
		status          int
		code            string
		allow           string
	}{
		{name: "unknown route", path: "/v1/prover/unknown", method: http.MethodPost, status: http.StatusNotFound, code: "not_found"},
		{name: "method", path: depositProofPath, method: http.MethodGet, status: http.StatusMethodNotAllowed, code: "method_not_allowed", allow: http.MethodPost},
		{name: "content type", path: depositProofPath, method: http.MethodPost, contentType: "text/plain", body: `{}`, status: http.StatusUnsupportedMediaType, code: "invalid_request"},
		{name: "content encoding", path: depositProofPath, method: http.MethodPost, contentEncoding: "br", body: `{}`, status: http.StatusBadRequest, code: "invalid_request"},
		{name: "oversized", path: depositProofPath, method: http.MethodPost, contentType: "application/json", body: `{"long":true}`, status: http.StatusRequestEntityTooLarge, code: "invalid_request"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
			if test.contentType != "" {
				request.Header.Set("Content-Type", test.contentType)
			}
			if test.contentEncoding != "" {
				request.Header.Set("Content-Encoding", test.contentEncoding)
			}
			handler.ServeHTTP(recorder, request)

			assertCanonicalError(t, recorder, test.status, test.code, false)
			require.Equal(t, test.allow, recorder.Header().Get("Allow"))
		})
	}
	require.Zero(t, prover.calls)
}

func TestDepositProofHandlerKeepsCanonicalHealthRoute(t *testing.T) {
	prover := &recordingNoteProver{proof: canonicalTestProof(t)}
	handler, err := newDepositProofHandler(prover, defaultMaxRequestBytes)
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, healthPath, nil)

	handler.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.Equal(t, "application/json", recorder.Header().Get("Content-Type"))
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
	var response map[string]string
	require.NoError(t, decodeStrictJSON(recorder.Body.Bytes(), &response))
	require.Equal(t, map[string]string{"version": "v1", "status": "ok"}, response)
	require.Zero(t, prover.calls)
}

func TestDepositProofHandlerRejectsNonCanonicalPathsWithoutRedirect(t *testing.T) {
	prover := &recordingNoteProver{proof: canonicalTestProof(t)}
	handler, err := newDepositProofHandler(prover, defaultMaxRequestBytes)
	require.NoError(t, err)

	for _, path := range []string{
		"/v1//prover/deposit",
		"/v1/prover/./deposit",
		"/v1/prover/../prover/deposit",
		"/v1/prover/unknown/../deposit",
		"/v1/prover/%64eposit",
		depositProofPath + "/",
		"/healthz/",
	} {
		t.Run(path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(
				http.MethodPost,
				path,
				bytes.NewReader(marshalDepositRequest(t, depositRequestForNote(t, validTestNote(t)))),
			)
			request.Header.Set("Content-Type", "application/json")
			handler.ServeHTTP(recorder, request)

			assertCanonicalError(t, recorder, http.StatusNotFound, "not_found", false)
			require.Empty(t, recorder.Header().Get("Location"))
		})
	}
	require.Zero(t, prover.calls)
}

func TestDepositProofHandlerClassifiesProverFailure(t *testing.T) {
	prover := &recordingNoteProver{err: errors.New("private solver detail")}
	handler, err := newDepositProofHandler(prover, defaultMaxRequestBytes)
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		depositProofPath,
		bytes.NewReader(marshalDepositRequest(t, depositRequestForNote(t, validTestNote(t)))),
	)
	handler.ServeHTTP(recorder, request)

	assertCanonicalError(t, recorder, http.StatusInternalServerError, "proof_failed", false)
	require.NotContains(t, recorder.Body.String(), "private solver detail")
}

func TestValidateListenAddressRequiresLoopback(t *testing.T) {
	require.NoError(t, validateListenAddress("127.0.0.1:8090"))
	require.NoError(t, validateListenAddress("[::1]:8090"))
	require.NoError(t, validateListenAddress("localhost:8090"))
	require.ErrorContains(t, validateListenAddress("0.0.0.0:8090"), "loopback")
}

func TestReferenceNoteProverGeneratesCanonicalDepositProof(t *testing.T) {
	if os.Getenv("CLAIRVEIL_DEPOSIT_PROVER_INTEGRATION") != "1" {
		t.Skip("set CLAIRVEIL_DEPOSIT_PROVER_INTEGRATION=1 with generated ZK artifacts")
	}
	proof, err := (referenceNoteProver{}).ProveDeposit(validTestNote(t))
	require.NoError(t, err)
	require.NoError(t, privacyzk.ValidateCanonicalProofBN254(proof))
}

func assertCanonicalError(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string, retryable bool) {
	t.Helper()
	require.Equal(t, status, recorder.Code)
	require.Equal(t, "application/json", recorder.Header().Get("Content-Type"))
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
	var response errorResponse
	require.NoError(t, decodeStrictJSON(recorder.Body.Bytes(), &response))
	require.Equal(t, depositProtocolVersion, response.Version)
	require.Equal(t, code, response.Code)
	require.NotEmpty(t, response.Message)
	require.Equal(t, retryable, response.Retryable)
}

func canonicalTestProof(t *testing.T) []byte {
	t.Helper()
	proof, err := hex.DecodeString(canonicalGeneratorGroth16ProofHex)
	require.NoError(t, err)
	require.Len(t, proof, privacyzk.CanonicalBN254Groth16ProofSize)
	require.NoError(t, privacyzk.ValidateCanonicalProofBN254(proof))
	return proof
}

func marshalDepositRequest(t *testing.T, request depositProofRequest) []byte {
	t.Helper()
	payload, err := json.Marshal(request)
	require.NoError(t, err)
	return payload
}

func depositRequestForNote(t *testing.T, note privacytypes.Note) depositProofRequest {
	t.Helper()
	return depositProofRequest{
		Version: depositProtocolVersion,
		Payload: depositProverPayload{
			Version:                depositProtocolVersion,
			ReceiverSpendPubKeyHex: encodedPointHex(t, note.ReceiverSpendPubKeyX, note.ReceiverSpendPubKeyY),
			ReceiverViewPubKeyHex:  encodedPointHex(t, note.ReceiverViewPubKeyX, note.ReceiverViewPubKeyY),
			Amount:                 note.Amount.String(),
			AssetIDHex:             canonicalFieldHex(t, note.AssetID),
			RandomnessHex:          canonicalFieldHex(t, note.Randomness),
			NoteCommitmentHex:      canonicalFieldHex(t, note.ComputeCommitment()),
		},
	}
}

func encodedPointHex(t *testing.T, x, y *big.Int) string {
	t.Helper()
	var point crypto_tedwards.PointAffine
	point.X.SetBigInt(x)
	point.Y.SetBigInt(y)
	encoded := point.Bytes()
	return hex.EncodeToString(encoded[:])
}

func canonicalFieldHex(t *testing.T, value *big.Int) string {
	t.Helper()
	encoded, err := privacyfield.CanonicalHexFromBigInt(value)
	require.NoError(t, err)
	return encoded
}

func validTestNote(t *testing.T) privacytypes.Note {
	t.Helper()
	rootSeed := bytes.Repeat([]byte{0x42}, privacyidentity.RootSeedLength)
	_, spendPubKey, _ := privacyidentity.DeriveSpendKeys(rootSeed)
	_, viewPubKey, _ := privacyidentity.DeriveViewKeys(rootSeed)
	return privacytypes.Note{
		ReceiverSpendPubKeyX: spendPubKey.X.BigInt(new(big.Int)),
		ReceiverSpendPubKeyY: spendPubKey.Y.BigInt(new(big.Int)),
		ReceiverViewPubKeyX:  viewPubKey.X.BigInt(new(big.Int)),
		ReceiverViewPubKeyY:  viewPubKey.Y.BigInt(new(big.Int)),
		Amount:               big.NewInt(7),
		AssetID:              privacytypes.ComputeAssetIDV1("uclair"),
		Randomness:           big.NewInt(13),
		Memo:                 "local deposit",
	}
}
