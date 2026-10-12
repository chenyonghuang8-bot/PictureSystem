/** Internal server evidence; JSON/control status objects cannot create it.
 * The repository issues it only from its single checked run/member snapshot. */
const proofs = new WeakMap<
  object,
  { runId: string; epoch: string; processId: string }
>();
export type RunAdmissionProof = Readonly<{
  runId: string;
  epoch: string;
  processId: string;
}>;
export function issueRunAdmissionProof(
  identity: RunAdmissionProof,
): RunAdmissionProof {
  const proof = Object.freeze({ ...identity });
  proofs.set(proof, proof);
  return proof;
}
export function verifyRunAdmissionProof(
  proof: unknown,
): proof is RunAdmissionProof {
  return typeof proof === "object" && proof !== null && proofs.has(proof);
}
