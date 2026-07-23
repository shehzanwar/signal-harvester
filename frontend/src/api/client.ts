import type {
  Article,
  ArticlesResponse,
  Comment,
  ProfileInfo,
  Run,
  StaticMeta,
  Stats,
  TrendsResponse,
} from "../types";

const IS_STATIC = import.meta.env.VITE_STATIC === "true";
const API_BASE = "/api";
const DATA_BASE = "./data";

// Static mode has no per-article endpoint — comments.json is one blob keyed
// by article_id, fetched once and cached across the session.
let _staticCommentsCache: Promise<Record<string, Comment[]>> | null = null;
function getStaticComments(): Promise<Record<string, Comment[]>> {
  if (!_staticCommentsCache) {
    _staticCommentsCache = getStatic<Record<string, Comment[]>>("comments.json").catch(() => ({}));
  }
  return _staticCommentsCache;
}

// ── Live API helpers ─────────────────────────────────────────────────────────
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ── Static data helpers ──────────────────────────────────────────────────────
async function getStatic<T>(file: string): Promise<T> {
  const res = await fetch(`${DATA_BASE}/${file}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ── API client ───────────────────────────────────────────────────────────────
export const api = {
  articles: (params?: {
    tier?: string;
    search?: string;
    today_only?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<ArticlesResponse> => {
    if (IS_STATIC) return getStatic<ArticlesResponse>("articles.json");
    const q = new URLSearchParams();
    if (params?.tier) q.set("tier", params.tier);
    if (params?.search) q.set("search", params.search);
    if (params?.today_only) q.set("today_only", "true");
    if (params?.limit != null) q.set("limit", String(params.limit));
    if (params?.offset != null) q.set("offset", String(params.offset));
    const qs = q.toString();
    return get<ArticlesResponse>(`/articles${qs ? `?${qs}` : ""}`);
  },

  stats: (): Promise<Stats> =>
    IS_STATIC ? getStatic<Stats>("stats.json") : get<Stats>("/stats"),

  trends: (days = 30): Promise<TrendsResponse> =>
    IS_STATIC
      ? getStatic<TrendsResponse>("trends.json")
      : get<TrendsResponse>(`/trends?days=${days}`),

  runs: (limit = 10): Promise<Run[]> =>
    IS_STATIC ? Promise.resolve([]) : get<Run[]>(`/runs?limit=${limit}`),

  profile: (): Promise<ProfileInfo> =>
    IS_STATIC ? getStatic<ProfileInfo>("profile.json") : get<ProfileInfo>("/profile"),

  meta: (): Promise<StaticMeta | null> =>
    IS_STATIC ? getStatic<StaticMeta>("meta.json").catch(() => null) : Promise.resolve(null),

  comments: async (articleId: string): Promise<Comment[]> => {
    if (IS_STATIC) {
      const all = await getStaticComments();
      return all[articleId] ?? [];
    }
    return get<Comment[]>(`/articles/${articleId}/comments`);
  },
};

export const IS_STATIC_MODE = IS_STATIC;

export function getArticlesByTier(articles: Article[]): Record<string, Article[]> {
  const buckets: Record<string, Article[]> = { T1: [], T2: [], T3: [], NOISE: [] };
  for (const a of articles) {
    buckets[a.tier]?.push(a);
  }
  return buckets;
}
