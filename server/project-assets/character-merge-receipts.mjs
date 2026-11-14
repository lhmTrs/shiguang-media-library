import { isRecord } from '../project-attributes/model.mjs';
import { fault } from './model.mjs';

// Rejections do not create a merge. Keep the existing NOT NULL UUID column
// and distinguish the receipt types by status in result_json.
export const rejectedMergeId = '00000000-0000-0000-0000-000000000000';
const rejectionStatuses = new Map([
  ['CHARACTER_MERGE_STALE', 409],
  ['CHARACTER_MERGE_CHOICE_INVALID', 422],
  ['CHARACTER_MERGE_UNDO_STALE', 409],
  ['CHARACTER_MERGE_UNDO_BLOCKED', 409],
  ['ATTRIBUTE_ALIGNMENT_REQUIRED', 409],
]);

export function rejectionReceipt(requestId, error) {
  if (!error?.status || rejectionStatuses.get(error.code) !== error.status) return null;
  return {
    request_id: requestId, status: 'rejected', code: error.code, message: error.message, http_status: error.status,
    ...(error.details !== undefined && { details: error.details }),
  };
}

export function validRejectionReceipt(result) {
  return rejectionStatuses.has(result.code) && rejectionStatuses.get(result.code) === result.http_status &&
    typeof result.message === 'string' && result.message.length > 0 &&
    Object.keys(result).every(key => ['request_id', 'status', 'code', 'message', 'http_status', 'details'].includes(key)) &&
    (!Object.hasOwn(result, 'details') || isRecord(result.details) && !Object.hasOwn(result.details, 'request_settled'));
}

export function rejectedResponse(result) {
  return fault(result.message, result.http_status, {
    code: result.code, details: { ...result.details, request_settled: true },
  });
}
