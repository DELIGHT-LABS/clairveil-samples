// Amount fields use the chain's minimal denomination, so they accept canonical
// integer strings only. Keep an in-progress non-integer value visible for the
// normal validator to reject rather than silently changing its meaning.
export function normalizeLeadingZeroMinimalDenomAmount(value) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) return text;
  return text.replace(/^0+(?=\d)/, "");
}
