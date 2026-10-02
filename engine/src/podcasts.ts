export interface PodcastShow {
  id: string;
  title: string;
  author: string;
  feedUrl: string;
  sourceUrl: string;
  artworkUrl?: string;
  country: string;
}

export interface PodcastEpisode {
  guid: string;
  title: string;
  description: string;
  publishedAt: string | null;
  durationMs: number;
  audioUrl: string;
  mimeType: string;
  transcriptUrl?: string;
}

export interface PodcastShowPage {
  show: PodcastShow;
  episodes: PodcastEpisode[];
  checkedAt: number;
  stale: boolean;
}

export interface PodcastSubscriptions {
  subscriptions: {
    show: PodcastShow;
    subscribedAt: number;
    checkedAt: number;
    stale: boolean;
  }[];
  episodes: { show: PodcastShow; episode: PodcastEpisode }[];
}

export type PodcastSelection =
  { url: string } | { showId: string; country: string; guid: string };
