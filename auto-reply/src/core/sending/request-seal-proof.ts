import type { RequestSealInput } from '../../shared/contracts/request-seal'
import { hashContext } from '../reply/hashes'

/** Only call after reading an unresolved journal with no permit/dispatch marker. */
export function requestNonDispatchProof(
  input: Pick<RequestSealInput, 'executionId' | 'identity' | 'request'>
): string {
  return hashContext({ kind: 'permit_request_never_dispatched', ...input })
}
