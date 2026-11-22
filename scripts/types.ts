export type FailureCategory = "unreachable" | "verification" | "deleted" | "permission" | "parse";
export class FetchFailure extends Error {
  constructor(public category: FailureCategory, message: string, public detail: Record<string, unknown> = {}) { super(message); }
}
// A single response/image can be discarded without cancelling the article budget.
export function resourceRejection(reason: string) {
  return new FetchFailure("parse", `资源限制：${reason}`, { retryable: false });
}
export type NetworkHop = { url: string; address?: string; status?: number; error?: string };
export type TimeAttempt = { source: string; outcome: "missing" | "invalid" | "selected" | "not_used"; value?: string; reason?: string };
export type ImageAttempt = { mode: "no_referer" | "wechat_referer" | "source_referer"; startedAt: string; outcome: "real_image" | "rejected"; status?: number; bytes?: number; reason?: string; sha256?: string; width?: number; height?: number; hops: NetworkHop[] };
export type ImageResult = { originalUrl: string; occurrences: number; assetId?: string; attempts: ImageAttempt[] };
export type Asset = { id: string; itemId: string; originalUrl: string; relativePath: string; mime: string; bytes: number; sha256: string; width: number; height: number };
export type ExtractionMeta = {
  extractor: string; version: string; articleRequests: NetworkHop[];
  timeAttempts: TimeAttempt[]; selectedTimeSource: string | null;
  images: ImageResult[]; imagesTotal: number; imagesSaved: number;
  textSourceChars: number; textSavedChars: number; textCoverage: number;
  textCoverageBasis: string;
  wikiLocation?: { spaceId: string; path: string[]; complete: boolean };
  structure?: { preserved: number; total: number; placeholders: number };
  page?: { status: number; finalUrl: string; contentType: string; diagnosis: "article" | "access_restricted" | "dynamic_suspected" | "no_body" | "non_html" };
  resourceLimitations?: { source: string; reason: string }[];
};
export type Snapshot = { documentId?: string; title: string; author: string | null; publishedAt: string | null; snapshotHtml: string; snapshotMd: string; assets: Asset[]; meta: ExtractionMeta };
