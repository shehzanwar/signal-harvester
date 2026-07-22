export type Tier = "T1" | "T2" | "T3" | "NOISE";
export type SentimentLabel = "positive" | "negative" | "neutral" | "mixed";

export interface Article {
  id: string;
  feed_name: string;
  url: string;
  guid?: string;
  title: string;
  published_at?: string;
  fetched_at: string;
  extracted_text?: string;
  summary?: string;
  status: string;
  // enrichment fields (joined)
  enrich_summary?: string;
  tier: Tier;
  tier_rationale?: string;
  sentiment_label: SentimentLabel;
  sentiment_score: number;
  sentiment_rationale?: string;
  // predicted_reaction: how the general public would likely react (present on v5+ enrichments)
  predicted_reaction_label?: SentimentLabel;
  predicted_reaction_score?: number;
  predicted_reaction_rationale?: string;
  tags: string[];
  model?: string;
  enriched_at?: string;
  latency_ms?: number;
  prompt_version?: string;
  // feed-derived category (technology / finance / politics / sports / world)
  category?: string;
  // cluster fields
  cluster_id?: string;
  cluster_size?: number;
  cluster_sources?: string[];
  // social signals — aggregated across providers (hn, lemmy, mastodon, bluesky, reddit)
  social?: SocialSignal[];
  social_score?: number;
}

export interface SocialSignal {
  source: string;
  score: number;
  comments: number;
  permalink?: string | null;
}

export interface Stats {
  total_articles: number;
  enriched_articles: number;
  failed_llm: number;
  today_new: number;
  noise_filtered: number;
  avg_sentiment: number | null;
  avg_sentiment_7d: number | null;
  tiers: Record<Tier, number>;
  t1_7d: number;
  last_run: Run | null;
}

export interface Run {
  id: string;
  profile: string;
  started_at: string;
  finished_at: string;
  fetched: number;
  new: number;
  enriched: number;
  failed: number;
  notes?: string;
}

export interface ProfileInfo {
  profile: string;
  dashboard_title: string;
  watch_topics: string[];
  feeds: Array<{ name: string; url: string; trust: string }>;
  model: string;
}

export interface ArticlesResponse {
  total: number;
  items: Article[];
}

export interface TrendsDay {
  date: string;
  T1: number;
  T2: number;
  T3: number;
  NOISE: number;
  avg_sentiment: number | null;
}

export interface TopTag {
  tag: string;
  count: number;
}

export interface TrendingTag {
  tag: string;
  today: number;
  // null for brand-new tags (status "new") that have no trailing-window history.
  avg7d: number | null;
  ratio: number | null;
  status: "trending" | "new";
}

export interface TrendsResponse {
  daily: TrendsDay[];
  top_tags: TopTag[];
  trending: TrendingTag[];
}

export interface StaticMeta {
  exported_at: string;
  prompt_version: string;
  total_articles: number;
  profile: string;
  static: boolean;
}
