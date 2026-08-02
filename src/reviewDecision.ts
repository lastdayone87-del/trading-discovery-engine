export type ReviewDecisionAction = 'approve' | 'reject' | 'force-rescan';

export interface ReviewDecisionRequest {
  channelId: string;
  action: ReviewDecisionAction;
  reviewVersion: number;
  reason: string;
  notes?: string;
}

export interface ReviewDecisionResult {
  decision: { decision: string; resulting_status: string; review_version: number };
  review: { state: string; reviewVersion: number };
  channel: { channelId: string; tradingStatus: string; scanStatus: string; discordStatus: string };
  queuePending: boolean;
  idempotent: boolean;
}

export async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: string; code?: string; requestId?: string };
  const message = body.error || body.code || `Review request failed (${response.status}).`;
  const requestId = body.requestId || response.headers.get('x-request-id');
  return requestId ? `${message} (request ${requestId})` : message;
}

/** Executes the review HTTP contract. Keeping this outside React makes request,
 * validation-error, and successful response behavior independently testable. */
export async function submitReviewDecision(
  request: ReviewDecisionRequest,
  fetcher: typeof fetch,
  headers: Record<string, string>,
  idempotencyKey: string = crypto.randomUUID()
): Promise<ReviewDecisionResult> {
  const response = await fetcher(`/api/reviews/${encodeURIComponent(request.channelId)}/${request.action}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ reviewVersion: request.reviewVersion, reason: request.reason, notes: request.notes || '' })
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<ReviewDecisionResult>;
}
