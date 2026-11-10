/** A review decision is only valid for the currently selected pending review. */
export function canSubmitReviewForSelection(
  bundle: { review?: { channelId?: string; state?: string } } | null,
  selectedChannelId: string | null,
): boolean {
  return Boolean(
    bundle?.review?.channelId
    && selectedChannelId
    && bundle.review.channelId === selectedChannelId
    && bundle.review.state === 'PENDING',
  );
}
