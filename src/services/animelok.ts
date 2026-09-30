export const ANIMELOK_BASE_URL = 'https://animelok.cc';

const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.6',
  'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not:A-Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

export type AnimeLokEpisode = {
  number: number;
  name: string;
  title: string | null;
  airdate: string | null;
  thumbnail?: string;
  image?: string;
  img?: string;
};

export type AnimeLokEpisodeList = { episodes: AnimeLokEpisode[]; total: number };
export type AnimeLokEmbed = { url: string; server: string };
export type AnimeLokServerGroup = { server: string; streams: { url: string; quality: string }[] };
export type AnimeLokTrack = {
  hash: string | null;
  servers: AnimeLokServerGroup[];
  embeds: AnimeLokEmbed[];
  best: string | null;
};
export type AnimeLokStreamTracks = { sub: AnimeLokTrack; dub: AnimeLokTrack };

type WatchProps = {
  totalEpisodes?: number | null;
  episodes: {
    number: number;
    title: string | null;
    image: string | null;
    airdate: string | null;
  }[];
};

type UpstreamServer = {
  source?: string;
  server?: string;
  type?: string;
  language?: string | null;
  url?: string;
};

type AnimeLokClientOptions = { baseUrl?: string };
type TrackMode = 'sub' | 'dub';
const SHORT_LINK = 'https://short.icu/';

export async function animelokFetch(
  path: string,
  headers: Record<string, string> = {},
  missing: number[] = [],
  baseUrl = ANIMELOK_BASE_URL,
): Promise<string | null> {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const route = path.startsWith('/') ? path : `/${path}`;
  const response = await fetch(`${base}${route}`, { headers: { ...HEADERS, ...headers } });
  if (response.ok) return response.text();
  if (missing.includes(response.status)) return null;
  throw new Error(`animelok responded ${response.status} for ${path}`);
}

function findWatchProps(node: unknown): WatchProps | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = node as Partial<WatchProps>;
  if (Array.isArray(candidate.episodes)) return candidate as WatchProps;
  for (const child of Object.values(node)) {
    const props = findWatchProps(child);
    if (props) return props;
  }
  return undefined;
}

function parseWatchPayload(payload: string): WatchProps | undefined {
  for (const line of payload.split('\n')) {
    if (!line.includes('"episodes":[')) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    try {
      const props = findWatchProps(JSON.parse(line.slice(separator + 1)));
      if (props) return props;
    } catch {
      continue;
    }
  }
  return undefined;
}

function videoHash(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts.length < 2 || parts[parts.length - 2].toLowerCase() !== 'video') return null;
    const value = parts[parts.length - 1];
    if (!value || ![...value].every((character) =>
      (character >= '0' && character <= '9') ||
      (character.toLowerCase() >= 'a' && character.toLowerCase() <= 'f'),
    )) return null;
    return value;
  } catch {
    return null;
  }
}

function serverName(server: UpstreamServer): string {
  if (server.server === 'default') return 'multi';
  if (server.server === 'multi-lang') return server.language || 'multi';
  return server.server || 'Unknown';
}

function toEmbed(server: UpstreamServer & { url: string }, track: TrackMode): AnimeLokEmbed {
  let url = server.url.startsWith(SHORT_LINK)
    ? `https://player.abyssplayer.com/${server.url.slice(SHORT_LINK.length)}`
    : server.url;
  if (server.source === 'reanime' && track === 'dub') {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}a=1`;
  }
  return { url, server: serverName(server) };
}

function buildTrack(servers: UpstreamServer[], track: TrackMode): AnimeLokTrack {
  const embeds = servers
    .filter((server): server is UpstreamServer & { url: string } => typeof server.url === 'string' && server.url.length > 0)
    .filter(({ type }) => type === track || (type !== 'sub' && type !== 'dub'))
    .map((server) => toEmbed(server, track));
  return {
    hash: embeds.map(({ url }) => videoHash(url)).find((value) => value !== null) ?? null,
    servers: [],
    embeds,
    best: embeds[0]?.url ?? null,
  };
}

export class AnimeLokClient {
  private readonly baseUrl: string;

  constructor(options: AnimeLokClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ANIMELOK_BASE_URL;
  }

  async scrapeEpisodes(anilistId: string): Promise<AnimeLokEpisodeList | null> {
    const payload = await animelokFetch(`/watch/${encodeURIComponent(anilistId)}`, { RSC: '1' }, [], this.baseUrl);
    const props = payload ? parseWatchPayload(payload) : undefined;
    if (!props) return null;
    const episodes = props.episodes.map((episode) => {
      const image = episode.image || undefined;
      return {
        number: episode.number,
        name: episode.title?.trim() || `Episode ${episode.number}`,
        title: episode.title,
        airdate: episode.airdate,
        thumbnail: image,
        image,
        img: image,
      };
    });
    return { episodes, total: props.totalEpisodes ?? episodes.length };
  }

  async scrapeStream(anilistId: string, episode: string): Promise<AnimeLokStreamTracks | null> {
    const payload = await animelokFetch(
      `/api/anilist/${encodeURIComponent(anilistId)}/${encodeURIComponent(episode)}`,
      {},
      [404, 502],
      this.baseUrl,
    );
    if (!payload) return null;
    const data = JSON.parse(payload) as { servers?: unknown };
    const servers = Array.isArray(data.servers) ? data.servers as UpstreamServer[] : [];
    return { sub: buildTrack(servers, 'sub'), dub: buildTrack(servers, 'dub') };
  }
}

export const animelok = new AnimeLokClient();
