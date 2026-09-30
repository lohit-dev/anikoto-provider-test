export type Mode = "sub" | "dub";
export type TranslationType = Mode;
export type CatalogProvider = "anikoto" | "anikoto2";
export type SearchSort = "latest-updated" | "latest-added" | "score" | "name-az" | "release-date" | "most-viewed" | "number_of_episodes";
export type SearchOptions = { allowAdult?: boolean; sort?: SearchSort };

export type AnikotoId = {
  anilistId?: string;
  malId?: string;
  anikotoId?: string;
  title?: string;
  episodes?: number;
};

export type SearchResult = {
  id: string;
  name: string;
  episodes: number;
  cover?: string;
  banner?: string;
  color?: string;
  format?: string;
  status?: string;
  year?: number;
  score?: number; // 0-100
  genres?: string[];
  provider?: CatalogProvider;
};
export type TimeRange = { start: number; end: number };
export type ShowDetails = {
  anilistId: string;
  malId?: string;
  title: { romaji?: string; english?: string; native?: string };
  synonyms: string[];
  description?: string;
  cover?: string;
  banner?: string;
  color?: string;
  format?: string;
  status?: string;
  season?: string;
  year?: number;
  startDate?: string;
  endDate?: string;
  episodes?: number;
  duration?: number;
  score?: number;
  popularity?: number;
  genres: string[];
  tags: { name: string; rank: number; spoiler: boolean }[];
  studios: string[];
  nextEpisode?: { episode: number; airingAt: number };
  trailer?: { site: string; id: string; url?: string };
  streamingEpisodes: { title: string; thumbnail?: string; url?: string }[];
  relations: { type: string; id: string; title?: string; format?: string }[];
};
export type Episode = {
  number: string;
  embedId?: string;
  subUrl?: string;
  dubUrl?: string;
  title?: string;
  thumbnail?: string;
  aired?: string;
  raw?: any; // untouched upstream item, so unknown fields are never lost
};
export type Subtitle = { label: string; url: string; default: boolean };
export type SubtitleTrack = Subtitle;
// Expo's native player expects request headers as a flat key/value object.
export type RequestHeaders = Record<string, string>;
export type Stream = {
  url: string;
  resolution: string;
  hls: boolean;
  headers: Record<string, string>;
  subtitles: Subtitle[];
  thumbnails?: string; // WebVTT sprite map for seek previews
  intro?: TimeRange;
  outro?: TimeRange;
  provider?: string;
  downloadable?: boolean;
};
export type StreamLink = Stream;

export type ThumbCue = { start: number; end: number; url: string; x: number; y: number; w: number; h: number };

import CryptoJS from 'crypto-js';
import { RateLimitedError } from './providerErrors';
export { RateLimitedError } from './providerErrors';

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const CACHE_TTL = 5 * 60_000;
const CACHE_LIMIT = 100;

// ---------- ids ----------
export const encodeId = (id: AnikotoId) => "anikoto:" + encodeURIComponent(JSON.stringify(id));

export function decodeId(value: string): AnikotoId {
  if (value !== "" && [...value].every((c) => c >= "0" && c <= "9")) return { anikotoId: value };
  if (!value.startsWith("anikoto:")) throw new Error("invalid Anikoto show ID");
  try {
    return JSON.parse(decodeURIComponent(value.slice("anikoto:".length)));
  } catch {
    throw new Error("invalid Anikoto show metadata");
  }
}

export const providerFromShowId = (id: string): CatalogProvider => (id.startsWith("anikoto2:") ? "anikoto2" : "anikoto");

export function parseSearchSort(value: string): SearchSort {
  const normalized = value.trim().toLowerCase().split('_').join('-');
  const aliases: Record<string, SearchSort> = {
    'latest-updated': 'latest-updated',
    'latest-added': 'latest-added',
    score: 'score',
    'name-az': 'name-az',
    nameaz: 'name-az',
    'release-date': 'release-date',
    releasedate: 'release-date',
    'most-viewed': 'most-viewed',
    mostviewed: 'most-viewed',
    'number-of-episodes': 'number_of_episodes',
    numberofepisodes: 'number_of_episodes',
  };
  const sort = aliases[normalized];
  if (!sort) throw new Error('search sort must be one of: latest-updated, latest-added, score, name-az, release-date, most-viewed, number_of_episodes');
  return sort;
}

export function sortEpisodes(episodes: string[]): void {
  episodes.sort((left, right) => {
    const a = Number(left);
    const b = Number(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
    return left.localeCompare(right);
  });
}

function resolutionWeight(value: string): number {
  let digits = '';
  for (const character of value) {
    if (character >= '0' && character <= '9') digits += character;
    else break;
  }
  return Number(digits) || (value.toLowerCase() === 'auto' ? -1 : 0);
}

function providerWeight(value: string | undefined): number {
  const provider = (value ?? '').toLowerCase();
  if (provider.includes('s-mp4')) return 3000;
  if (provider.includes('mp4')) return 2000;
  if (provider.includes('default')) return 1000;
  return 0;
}

export function sortStreams(streams: Stream[]): void {
  streams.sort((a, b) =>
    providerWeight(b.provider) - providerWeight(a.provider) ||
    resolutionWeight(b.resolution) - resolutionWeight(a.resolution) ||
    Number(b.hls) - Number(a.hls) ||
    (a.provider ?? '').localeCompare(b.provider ?? ''),
  );
}

export function chooseQuality(streams: Stream[], quality: string): Stream | undefined {
  if (!streams.length) return undefined;
  const requested = quality.trim().toLowerCase();
  if (requested === 'best') return streams[0];
  if (requested === 'worst') {
    const numbered = streams.filter((stream) => resolutionWeight(stream.resolution) > 0);
    return numbered.reduce<Stream | undefined>((worst, stream) =>
      !worst || resolutionWeight(stream.resolution) < resolutionWeight(worst.resolution) ? stream : worst,
      undefined) ?? streams[streams.length - 1];
  }
  return streams.find((stream) => stream.resolution.toLowerCase().includes(requested)) ?? streams[0];
}

export function expandEpisodeSelection(selection: string, available: string[]): string[] {
  const trimmed = selection.trim();
  if (trimmed === '-1') {
    const last = available[available.length - 1];
    if (last === undefined) throw new Error('no episodes available');
    return [last];
  }
  if ([...trimmed].some((character) => character.trim() === '')) {
    const requested: string[] = [];
    let current = '';
    for (const character of trimmed) {
      if (character.trim() === '') {
        if (current) requested.push(current);
        current = '';
      } else current += character;
    }
    if (current) requested.push(current);
    if (requested.every((episode) => available.includes(episode))) return requested;
    throw new Error('one or more selected episodes do not exist');
  }
  const rangeSeparator = trimmed.indexOf('-');
  if (rangeSeparator >= 0) {
    const start = trimmed.slice(0, rangeSeparator);
    let end = trimmed.slice(rangeSeparator + 1);
    if (end === '-1' || end === '') end = available[available.length - 1] ?? '';
    const startIndex = available.indexOf(start);
    const endIndex = available.indexOf(end);
    if (startIndex < 0) throw new Error('range start does not exist');
    if (endIndex < 0) throw new Error('range end does not exist');
    if (startIndex > endIndex) throw new Error('episode range is reversed');
    return available.slice(startIndex, endIndex + 1);
  }
  if (available.includes(trimmed)) return [trimmed];
  throw new Error('episode does not exist');
}

// ---------- small helpers ----------
const str = (v: any): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number") return String(v);
  return undefined;
};
const num = (v: any): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  return undefined;
};
const normalizeTitle = (s: string) => [...s].filter((c) => c.toLowerCase() !== c.toUpperCase() || (c >= "0" && c <= "9")).join("").toLowerCase();

// ---------- parsers ----------
export function parseSearchPayload(value: any, allowAdult: boolean): SearchResult[] {
  const items: any[] = value?.data?.Page?.media ?? (Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : []);
  const out: SearchResult[] = [];
  for (const item of items) {
    if (!allowAdult && (item?.isAdult ?? item?.is_adult) === true) continue;
    const anilistId = str(item?.ani_id ?? item?.id);
    if (!anilistId) continue;
    const t = item.title;
    const title =
      (typeof t === "string" ? t : undefined) ??
      (t && typeof t === "object" ? ["english", "romaji", "native"].map((k) => str(t[k])).find(Boolean) : undefined) ??
      str(item.name) ??
      `AniList ${anilistId}`;
    const episodes = num(item.episodes) ?? 0;
    let anikotoId: string | undefined;
    if (item.ani_id !== undefined) {
      const itemId = str(item.id);
      if (itemId !== str(item.ani_id)) anikotoId = itemId;
    }
    const cover = str(item.coverImage?.extraLarge) ?? str(item.coverImage?.large) ?? str(item.poster ?? item.image ?? item.cover);
    const year = num(item.seasonYear) ?? num(item.year);
    out.push({
      cover,
      banner: str(item.bannerImage),
      color: str(item.coverImage?.color),
      format: str(item.format),
      status: str(item.status),
      year,
      score: num(item.averageScore),
      genres: Array.isArray(item.genres) ? item.genres.filter((g: any) => typeof g === "string") : undefined,
      provider: "anikoto",
      id: encodeId({
        anilistId,
        malId: str(item.idMal ?? item.mal_id),
        anikotoId,
        title,
        episodes: Number.isFinite(episodes) && episodes > 0 ? Math.trunc(episodes) : undefined,
      }),
      name: title,
      episodes,
    });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
function fuzzyDate(d: any): string | undefined {
  if (!d?.year) return undefined;
  return d.month ? (d.day ? `${d.year}-${pad(d.month)}-${pad(d.day)}` : `${d.year}-${pad(d.month)}`) : String(d.year);
}

export function parseDetails(value: any): ShowDetails | null {
  const m = value?.data?.Media;
  if (!m || m.id === undefined) return null;
  const trailer = m.trailer?.id && m.trailer?.site
    ? {
      site: String(m.trailer.site),
      id: String(m.trailer.id),
      url: m.trailer.site === "youtube" ? `https://www.youtube.com/watch?v=${m.trailer.id}` : undefined,
    }
    : undefined;
  return {
    anilistId: String(m.id),
    malId: str(m.idMal),
    title: { romaji: str(m.title?.romaji), english: str(m.title?.english), native: str(m.title?.native) },
    synonyms: Array.isArray(m.synonyms) ? m.synonyms : [],
    description: str(m.description),
    cover: str(m.coverImage?.extraLarge) ?? str(m.coverImage?.large),
    banner: str(m.bannerImage),
    color: str(m.coverImage?.color),
    format: str(m.format),
    status: str(m.status),
    season: str(m.season),
    year: num(m.seasonYear),
    startDate: fuzzyDate(m.startDate),
    endDate: fuzzyDate(m.endDate),
    episodes: num(m.episodes),
    duration: num(m.duration),
    score: num(m.averageScore),
    popularity: num(m.popularity),
    genres: Array.isArray(m.genres) ? m.genres : [],
    tags: (m.tags ?? []).map((t: any) => ({ name: String(t.name), rank: num(t.rank) ?? 0, spoiler: !!(t.isMediaSpoiler || t.isGeneralSpoiler) })),
    studios: (m.studios?.nodes ?? []).filter((n: any) => n.isAnimationStudio).map((n: any) => String(n.name)),
    nextEpisode: m.nextAiringEpisode ? { episode: m.nextAiringEpisode.episode, airingAt: m.nextAiringEpisode.airingAt } : undefined,
    trailer,
    streamingEpisodes: (m.streamingEpisodes ?? []).map((e: any) => ({ title: String(e.title), thumbnail: str(e.thumbnail), url: str(e.url) })),
    relations: (m.relations?.edges ?? []).map((e: any) => ({
      type: String(e.relationType),
      id: String(e.node?.id),
      title: str(e.node?.title?.english) ?? str(e.node?.title?.romaji),
      format: str(e.node?.format),
    })),
  };
}

export function mergeSearchResults(recent: SearchResult[], anilist: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return [...recent, ...anilist].filter((item) => {
    let key: string;
    try {
      const a = decodeId(item.id).anilistId;
      key = a ? `ani:${a}` : `title:${normalizeTitle(item.name)}`;
    } catch {
      key = `title:${normalizeTitle(item.name)}`;
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseEpisodePayload(value: any): Episode[] {
  const data = value?.data ?? value;
  const list: any[] = Array.isArray(data?.episodes) ? data.episodes : [];
  const eps: Episode[] = [];
  for (const item of list) {
    const number = str(item?.number ?? item?.episode ?? item?.episode_number);
    if (!number) continue;
    eps.push({
      number,
      embedId: str(item.episode_embed_id),
      subUrl: str(item.embed_url?.sub),
      dubUrl: str(item.embed_url?.dub),
      title: str(item.title ?? item.name ?? item.episode_title),
      thumbnail: str(item.thumbnail ?? item.image ?? item.poster ?? item.snapshot),
      aired: str(item.aired ?? item.air_date ?? item.released ?? item.date),
      raw: item,
    });
  }
  return eps.sort((a, b) => Number(a.number) - Number(b.number) || a.number.localeCompare(b.number));
}

export function embedCandidates(base: string, id: AnikotoId, episode: string, mode: Mode, selected?: Episode): string[] {
  const c: string[] = [];
  if (selected) {
    const explicit = mode === "sub" ? selected.subUrl : selected.dubUrl;
    if (explicit) c.push(explicit);
    if (selected.embedId) c.push(`${base}/stream/s-2/${selected.embedId}/${mode}`);
  }
  if (id.anilistId) c.push(`${base}/stream/ani/${id.anilistId}/${episode}/${mode}`);
  if (id.malId) c.push(`${base}/stream/mal/${id.malId}/${episode}/${mode}`);
  return [...new Set(c)];
}

export function parseDataId(html: string): string | null {
  const lower = html.toLowerCase();
  let from = 0;
  while (true) {
    const at = lower.indexOf("data-id=", from);
    if (at === -1) return null;
    const quote = html[at + 8];
    from = at + 8;
    if (quote !== '"' && quote !== "'") continue;
    const end = html.indexOf(quote, at + 9);
    if (end === -1) return null;
    const digits = html.slice(at + 9, end);
    if (digits !== "" && [...digits].every((ch) => ch >= "0" && ch <= "9")) return digits;
  }
}

export function parseMegaplaySources(value: any): { sources: [string, string][]; subtitles: Subtitle[]; thumbnails?: string; intro?: TimeRange; outro?: TimeRange } {
  const sources: [string, string][] = [];
  const tracks: Subtitle[] = [];
  let thumbnails: string | undefined;

  const collectSources = (v: any) => {
    if (typeof v === "string") sources.push([v, "Auto"]);
    else if (Array.isArray(v)) v.forEach(collectSources);
    else if (v && typeof v === "object") {
      const url = [v.file, v.url, v.src].find((x) => typeof x === "string");
      if (url) sources.push([url, [v.label, v.quality].find((x) => typeof x === "string") ?? "Auto"]);
      for (const k of ["sources", "source", "links"]) if (v[k] !== undefined) collectSources(v[k]);
    }
  };
  const collectTracks = (v: any) => {
    if (Array.isArray(v)) v.forEach(collectTracks);
    else if (v && typeof v === "object") {
      const kind = String([v.kind, v.type].find((x) => typeof x === "string") ?? "").toLowerCase();
      if (kind.includes("thumbnail")) {
        const t = [v.file, v.url, v.src].find((x) => typeof x === "string");
        if (t && !thumbnails) thumbnails = t;
        return;
      }
      if (kind && !kind.includes("caption") && !kind.includes("subtitle") && !kind.includes("sub")) return;
      const url = [v.file, v.url, v.src].find((x) => typeof x === "string");
      if (url)
        tracks.push({
          label: [v.label, v.title].find((x) => typeof x === "string") ?? "Subtitle",
          url,
          default: v.default === true,
        });
    }
  };

  if (value?.sources !== undefined) collectSources(value.sources);
  if (value?.source !== undefined) collectSources(value.source);
  for (const k of ["tracks", "captions", "subtitles"]) if (value?.[k] !== undefined) collectTracks(value[k]);

  const seenS = new Set<string>();
  const seenT = new Set<string>();
  return {
    sources: sources.filter(([u]) => !seenS.has(u) && seenS.add(u)),
    subtitles: tracks.filter((t) => !seenT.has(t.url) && seenT.add(t.url)),
    thumbnails,
    intro: range(value?.intro),
    outro: range(value?.outro),
  };
}

function range(v: any): TimeRange | undefined {
  const start = num(v?.start);
  const end = num(v?.end);
  return start !== undefined && end !== undefined && end > start ? { start, end } : undefined;
}

function parseVttTime(t: string): number {
  const parts = t.trim().split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// Parses a thumbnails .vtt (cues like "sprite.jpg#xywh=0,0,160,90") into sprite rectangles.
export function parseThumbnailVtt(vtt: string, baseUrl: string): ThumbCue[] {
  const lines = vtt.split("\n").map((l) => l.trim());
  const cues: ThumbCue[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("-->")) continue;
    const [a, b] = lines[i].split("-->");
    const target = lines[i + 1];
    if (!target) continue;
    const [path, frag] = target.split("#xywh=");
    if (!frag) continue;
    const [x, y, w, h] = frag.split(",").map(Number);
    if ([x, y, w, h].some((n) => !Number.isFinite(n))) continue;
    cues.push({ start: parseVttTime(a), end: parseVttTime(b), url: new URL(path, baseUrl).toString(), x, y, w, h });
  }
  return cues;
}

export const thumbAt = (cues: ThumbCue[], seconds: number) =>
  cues.find((c) => seconds >= c.start && seconds < c.end);

const MEGAPLAY_HOSTS = [
  "megaplay.buzz", "mewstream.buzz", "lostproject.club", "voltara.click", "kotocdn.site",
  "megap.shiora.top", "shiora.top", "megap.kotocdn.site", "megap.akirax.buzz", "akirax.buzz",
];

export function isMegaplayMediaHost(host: string): boolean {
  let h = host.toLowerCase();
  while (h.endsWith(".")) h = h.slice(0, -1);
  return MEGAPLAY_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

export function validateRemoteUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("media URL contains credentials");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("media URL must use HTTPS");
  return url;
}

function mediaHeaders(host: string): Record<string, string> {
  return isMegaplayMediaHost(host)
    ? { Referer: "https://megaplay.buzz/", Origin: "https://megaplay.buzz", "User-Agent": UA }
    : {};
}

// ---------- client ----------
type Cached<T> = { exp: number; value: T };

function cacheGet<T>(m: Map<string, Cached<T>>, k: string): T | undefined {
  const hit = m.get(k);
  if (!hit) return undefined;
  if (hit.exp <= Date.now()) {
    m.delete(k);
    return undefined;
  }
  return hit.value;
}
function cachePut<T>(m: Map<string, Cached<T>>, k: string, value: T) {
  if (m.size >= CACHE_LIMIT) m.delete(m.keys().next().value!);
  m.set(k, { exp: Date.now() + CACHE_TTL, value });
}

export type ClientOptions = { anikotoApi?: string; anilistApi?: string; megaplayBase?: string; anikotoCzBase?: string; mapperBase?: string };

export class AnikotoClient {
  private anikotoApi: string;
  private anilistApi: string;
  private megaplayBase: string;
  private searches = new Map<string, Cached<SearchResult[]>>();
  private series = new Map<string, Cached<Episode[]>>();
  private detailsCache = new Map<string, Cached<ShowDetails>>();
  private anikotoCz: AnikotoCzClient;

  constructor(o: ClientOptions = {}) {
    this.anikotoApi = (o.anikotoApi ?? "https://anikotoapi.site").replace(/\/+$/, "");
    this.anilistApi = o.anilistApi ?? "https://graphql.anilist.co";
    this.megaplayBase = (o.megaplayBase ?? "https://megaplay.buzz").replace(/\/+$/, "");
    this.anikotoCz = new AnikotoCzClient({ base: o.anikotoCzBase, mapperBase: o.mapperBase });
  }

  private async checked(res: Response, provider: string) {
    if (res.status === 429) throw new RateLimitedError(provider, Number(res.headers.get("retry-after")) || 120);
    if (!res.ok) throw new Error(`${provider} HTTP ${res.status}`);
    return res;
  }

  private async getJson(url: string, headers: Record<string, string> = {}) {
    const provider = url.startsWith(this.megaplayBase) ? "MegaPlay" : "Anikoto";
    const res = await fetch(url, { headers: { Accept: "application/json,text/plain,*/*", ...headers } });
    return (await this.checked(res, provider)).json();
  }

  async search(query: string, allowAdultOrOptions: boolean | SearchOptions = false): Promise<SearchResult[]> {
    query = query.trim();
    if (!query) throw new Error("empty search query");
    const options = typeof allowAdultOrOptions === 'boolean'
      ? { allowAdult: allowAdultOrOptions }
      : allowAdultOrOptions;
    const allowAdult = options.allowAdult ?? false;
    const sort = options.sort;
    const key = `${allowAdult}:${sort ?? ''}:${query.toLowerCase()}`;
    const cached = cacheGet(this.searches, key);
    if (cached) return cached;

    const [cz, recent, anilist] = await Promise.allSettled([
      this.anikotoCz.search(query, sort),
      this.searchRecent(query, allowAdult),
      this.searchAnilist(query, allowAdult),
    ]);

    let values: SearchResult[];
    if (cz.status === "fulfilled" && recent.status === "fulfilled" && anilist.status === "fulfilled") values = mergeSearchResults([...cz.value, ...recent.value], anilist.value);
    else if (cz.status === "fulfilled" && recent.status === "fulfilled") values = mergeSearchResults(cz.value, recent.value);
    else if (cz.status === "fulfilled" && anilist.status === "fulfilled") values = mergeSearchResults(cz.value, anilist.value);
    else if (recent.status === "fulfilled" && anilist.status === "fulfilled") values = mergeSearchResults(recent.value, anilist.value);
    else if (cz.status === "fulfilled" && cz.value.length) values = cz.value;
    else if (recent.status === "fulfilled" && recent.value.length) values = recent.value;
    else if (anilist.status === "fulfilled") values = anilist.value;
    else {
      const errs = [cz, recent, anilist].flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      const rl = errs.find((e) => e instanceof RateLimitedError);
      if (rl) throw rl;
      if (errs.length) throw new Error(`Anikoto search sources failed: ${errs.join('; ')}`);
      values = [];
    }
    const anilistResults = anilist.status === "fulfilled" ? anilist.value : [];
    values = values.map((item) => {
      if (!item.id.startsWith("anikoto2:")) return item;
      const normalized = normalizeTitle(item.name);
      const match = anilistResults.find((candidate) => normalizeTitle(candidate.name) === normalized);
      if (!match) return item;
      return {
        ...match,
        ...item,
        cover: item.cover ?? match.cover,
        banner: item.banner ?? match.banner,
        color: item.color ?? match.color,
        format: item.format ?? match.format,
        status: item.status ?? match.status,
        year: item.year ?? match.year,
        score: item.score ?? match.score,
        genres: item.genres ?? match.genres,
      };
    });
    const names = new Set<string>();
    values = values.filter((item) => {
      const key = normalizeTitle(item.name);
      if (names.has(key)) return false;
      names.add(key);
      return true;
    });
    cachePut(this.searches, key, values);
    return values;
  }

  private async searchRecent(query: string, allowAdult: boolean) {
    const v = await this.getJson(`${this.anikotoApi}/recent-anime?page=1&per_page=40`);
    const needle = query.toLowerCase();
    return parseSearchPayload(v, allowAdult).filter((r) => r.name.toLowerCase().includes(needle));
  }

  private async searchAnilist(query: string, allowAdult: boolean) {
    const gql = `query ($search: String!) { Page(page: 1, perPage: 40) { media(type: ANIME, search: $search, sort: SEARCH_MATCH) { id idMal title { romaji english native } episodes isAdult coverImage { extraLarge large color } bannerImage format status seasonYear averageScore genres } } }`;
    const res = await fetch(this.anilistApi, {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://anilist.co/" },
      body: JSON.stringify({ query: gql, variables: { search: query } }),
    });
    return parseSearchPayload(await (await this.checked(res, "AniList")).json(), allowAdult);
  }

  async details(showId: string): Promise<ShowDetails> {
    if (showId.startsWith("anikoto2:")) {
      const metadata = decodeCzId(showId);
      const matches = await this.searchAnilist(metadata.title, false);
      if (!matches.length) throw new Error(`No AniList details found for ${metadata.title}`);
      const normalized = normalizeTitle(metadata.title);
      const match = matches.find((result) => normalizeTitle(result.name) === normalized) ?? matches[0];
      return this.details(match.id);
    }
    const id = decodeId(showId);
    const key = id.anilistId ? "id" : id.malId ? "idMal" : undefined;
    if (!key) throw new Error("show has no AniList or MAL id");
    const cacheKey = `${key}:${id.anilistId ?? id.malId}`;
    const cached = cacheGet(this.detailsCache, cacheKey);
    if (cached) return cached;

    const gql = `query ($id: Int) { Media(${key}: $id, type: ANIME) {
      id idMal title { romaji english native } synonyms description(asHtml: false)
      coverImage { extraLarge large color } bannerImage format status season seasonYear
      startDate { year month day } endDate { year month day } episodes duration
      averageScore popularity genres tags { name rank isMediaSpoiler isGeneralSpoiler }
      studios { nodes { name isAnimationStudio } } nextAiringEpisode { episode airingAt }
      trailer { id site } streamingEpisodes { title thumbnail url }
      relations { edges { relationType node { id title { romaji english } format } } } } }`;
    const res = await fetch(this.anilistApi, {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://anilist.co/" },
      body: JSON.stringify({ query: gql, variables: { id: Number(id.anilistId ?? id.malId) } }),
    });
    const d = parseDetails(await (await this.checked(res, "AniList")).json());
    if (!d) throw new Error("AniList returned no details");
    cachePut(this.detailsCache, cacheKey, d);
    return d;
  }

  // Full episode objects (title/thumbnail/aired when the API provides them), not just numbers.
  async episodeList(showId: string): Promise<Episode[]> {
    if (showId.startsWith("anikoto2:")) return this.anikotoCz.episodeList(showId);
    const id = decodeId(showId);
    const series = await this.loadSeries(id).catch(() => [] as Episode[]);
    if (series.length) return series;
    return (await this.episodes(showId)).map((number) => ({ number }));
  }

  private async loadSeries(id: AnikotoId): Promise<Episode[]> {
    if (!id.anikotoId) return [];
    const cached = cacheGet(this.series, id.anikotoId);
    if (cached) return cached;
    const v = parseEpisodePayload(await this.getJson(`${this.anikotoApi}/series/${id.anikotoId}`));
    cachePut(this.series, id.anikotoId, v);
    return v;
  }

  async episodes(showId: string): Promise<string[]> {
    if (showId.startsWith("anikoto2:")) return this.anikotoCz.episodes(showId, "sub");
    const id = decodeId(showId);
    let series: Episode[] = [];
    try {
      series = await this.loadSeries(id);
    } catch (e) {
      if (!id.episodes && !id.anilistId && !id.malId) throw e;
    }
    if (series.length) return series.map((e) => e.number);
    let count = id.episodes;
    if ((!count || count < 1) && (id.anilistId || id.malId)) {
      count = (await this.details(showId)).episodes;
    }
    if (!count || !Number.isFinite(count) || count < 1) {
      throw new Error(`no episodes available for ${id.title ?? "this show"}`);
    }
    return Array.from({ length: Math.trunc(count) }, (_, i) => String(i + 1));
  }

  async streams(showId: string, episode: string, mode: Mode): Promise<Stream[]> {
    if (showId.startsWith("anikoto2:")) return this.anikotoCz.streams(showId, episode, mode);
    const id = decodeId(showId);
    let series: Episode[] = [];
    try {
      series = await this.loadSeries(id);
    } catch (e) {
      if (!(id.anilistId || id.malId)) throw e;
    }
    const selected = series.find((e) => e.number === episode);
    const candidates = embedCandidates(this.megaplayBase, id, episode, mode, selected);
    if (!candidates.length) throw new Error(`no episodes available for ${id.title ?? "this show"}`);

    const failures: string[] = [];
    for (const c of candidates) {
      try {
        const s = await this.resolveMegaplay(c);
        if (s.length) return s;
        failures.push("MegaPlay returned no native streams");
      } catch (e) {
        if (e instanceof RateLimitedError) throw e;
        failures.push(String(e));
      }
    }
    console.warn("Anikoto source resolution failures:", failures.join("; "));
    throw new Error(`no playable sources for ${id.title ?? "this show"} episode ${episode} (${mode})`);
  }

  async discoverQualities(stream: Stream): Promise<Stream[]> {
    return this.anikotoCz.expandStreamQualities(stream);
  }

  async resolveMegaplay(embedUrl: string): Promise<Stream[]> {
    validateRemoteUrl(embedUrl);
    const res = await fetch(embedUrl, {
      headers: { Referer: `${this.megaplayBase}/`, Accept: "text/html,application/json,text/plain,*/*" },
    });
    const html = await (await this.checked(res, "MegaPlay")).text();
    const dataId = parseDataId(html);
    if (!dataId) throw new Error("embed did not expose a playable source id");

    const payload = await this.getJson(`${this.megaplayBase}/stream/getSources?id=${dataId}`, {
      Referer: embedUrl,
      Origin: this.megaplayBase,
    });
    const { sources, subtitles, thumbnails, intro, outro } = parseMegaplaySources(payload);
    if (!sources.length) throw new Error("MegaPlay returned no native streams");

    const streams: Stream[] = [];
    for (const [url, resolution] of sources) {
      const parsed = validateRemoteUrl(url);
      const hls = parsed.pathname.toLowerCase().includes(".m3u8") || parsed.search.includes(".m3u8");
      const headers = mediaHeaders(parsed.hostname);
      const expanded: Stream[] = hls
        ? [{ url, resolution, hls: true, headers, subtitles: [] as Subtitle[], provider: 'MegaPlay', downloadable: true }]
        : [{ url, resolution, hls: false, headers, subtitles: [] as Subtitle[], provider: 'MegaPlay', downloadable: true }];
      expanded.forEach((s) => {
        s.subtitles = subtitles;
        s.thumbnails = thumbnails;
        s.intro = intro;
        s.outro = outro;
      });
      streams.push(...expanded);
    }
    const seen = new Set<string>();
    const unique = streams.filter((s) => !seen.has(s.url) && seen.add(s.url));
    sortStreams(unique);
    return unique;
  }

  async expandHls(url: string, fallback: string, headers: Record<string, string>): Promise<Stream[]> {
    const single = (): Stream[] => [{ url, resolution: fallback, hls: true, headers, subtitles: [] }];
    const res = await fetch(url, { headers });
    if (!res.ok) return single();
    const text = await res.text();
    if (!text.trimStart().startsWith("#EXTM3U")) return single();

    const lines = text.split("\n").map((l) => l.trim());
    const out: Stream[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
      const at = lines[i].indexOf("RESOLUTION=");
      const height = at === -1 ? undefined : lines[i].slice(at + 11).split(",")[0].split("x")[1];
      const next = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
      if (next) out.push({ url: new URL(next, url).toString(), resolution: height ? `${height}p` : fallback, hls: true, headers, subtitles: [] });
    }
    return out.length ? out : single();
  }
}


// ---------- Anikoto.cz provider, source extraction, and crypto ----------

const BASE = 'https://anikoto.cz';
const MAPPER_BASE = 'https://mapper.nekostream.site/api/mal';
const CZ_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_MS = 5 * 60_000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export type AnikotoCzId = { slug: string; title: string; episodes?: number };
type CacheEntry<T> = { expires: number; value: T };
type EpisodeRow = { number: string; slug: string; token: string; malId: string; timestamp: string; sub: boolean; dub: boolean };
type Series = { canonical: string; episodes: EpisodeRow[] };
type Server = { label: string; token: string };
type Tree = { tag: string; attrs: Record<string, string>; children: Tree[]; content: string[] };

export function encodeCzId(value: AnikotoCzId): string {
  const bytes = utf8Bytes(JSON.stringify(value));
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    encoded += ALPHABET[a >> 2];
    encoded += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) encoded += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) encoded += ALPHABET[c & 63];
  }
  return `anikoto2:${encoded}`;
}

export function decodeCzId(value: string): AnikotoCzId {
  const rawSlug = value.startsWith('anikoto2:') ? undefined : value;
  if (rawSlug && validSlug(rawSlug)) return { slug: rawSlug, title: rawSlug.split('-').join(' ') };
  if (!value.startsWith('anikoto2:')) throw new Error('invalid Anikoto.cz show ID');
  const encoded = value.slice('anikoto2:'.length);
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of encoded) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('invalid Anikoto.cz show ID encoding');
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 255);
    }
  }
  try {
    const percentEncoded = bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
    const decoded = JSON.parse(decodeURIComponent(percentEncoded)) as AnikotoCzId;
    if (!validSlug(decoded.slug) || typeof decoded.title !== 'string') throw new Error('invalid metadata');
    return decoded;
  } catch {
    throw new Error('invalid Anikoto.cz show metadata');
  }
}

function validSlug(value: string): boolean {
  if (value.length < 1 || value.length > 200) return false;
  for (const character of value.toLowerCase()) {
    if (!((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character === '-')) return false;
  }
  return value[0] !== '-';
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let index = 0;
  while (index < source.length && !isSpace(source[index]) && source[index] !== '/') index++;
  while (index < source.length) {
    while (isSpace(source[index]) || source[index] === '/') index++;
    const start = index;
    while (index < source.length && !isSpace(source[index]) && source[index] !== '=' && source[index] !== '/') index++;
    if (index === start) break;
    const name = source.slice(start, index).toLowerCase();
    while (isSpace(source[index])) index++;
    let value = '';
    if (source[index] === '=') {
      index++;
      while (isSpace(source[index])) index++;
      const quote = source[index] === '"' || source[index] === "'" ? source[index++] : '';
      const valueStart = index;
      if (quote) {
        while (index < source.length && source[index] !== quote) index++;
        value = source.slice(valueStart, index);
        index++;
      } else {
        while (index < source.length && !isSpace(source[index]) && source[index] !== '>') index++;
        value = source.slice(valueStart, index);
      }
    }
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

function htmlTree(html: string): Tree {
  const root: Tree = { tag: 'root', attrs: {}, children: [], content: [] };
  const stack = [root];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) {
      stack[stack.length - 1].content.push(html.slice(index));
      break;
    }
    if (open > index) stack[stack.length - 1].content.push(html.slice(index, open));
    if (html.startsWith('<!--', open)) {
      const closeComment = html.indexOf('-->', open + 4);
      index = closeComment < 0 ? html.length : closeComment + 3;
      continue;
    }
    const close = html.indexOf('>', open + 1);
    if (close < 0) break;
    const source = html.slice(open + 1, close).trim();
    if (source.startsWith('/')) {
      const tag = source.slice(1).trim().split(' ')[0]?.toLowerCase();
      for (let cursor = stack.length - 1; cursor > 0; cursor--) {
        if (stack[cursor].tag === tag) {
          stack.length = cursor;
          break;
        }
      }
    } else if (source && !source.startsWith('!') && !source.startsWith('?')) {
      let splitAt = 0;
      while (splitAt < source.length && !isSpace(source[splitAt]) && source[splitAt] !== '/') splitAt++;
      const tag = source.slice(0, splitAt).toLowerCase();
      const node: Tree = { tag, attrs: parseAttrs(source), children: [], content: [] };
      stack[stack.length - 1].children.push(node);
      const selfClosing = source.endsWith('/') || ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag);
      if (!selfClosing) stack.push(node);
    }
    index = close + 1;
  }
  return root;
}

function isSpace(value?: string): boolean {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t' || value === '\f';
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes.push(code);
    else if (code <= 0x7ff) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code <= 0xffff) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  let output = '';
  let index = 0;
  while (index < value.length) {
    if (value[index] !== '&') {
      output += value[index++];
      continue;
    }
    const end = value.indexOf(';', index + 1);
    if (end < 0 || end - index > 12) {
      output += value[index++];
      continue;
    }
    const entity = value.slice(index + 1, end);
    const replacement = entity[0] === '#' ? decodeNumericEntity(entity.slice(1)) : named[entity];
    if (replacement === undefined) output += value.slice(index, end + 1);
    else output += replacement;
    index = end + 1;
  }
  return output;
}

function decodeNumericEntity(value: string): string | undefined {
  const hexadecimal = value[0]?.toLowerCase() === 'x';
  const digits = hexadecimal ? value.slice(1) : value;
  let code = 0;
  for (const character of digits.toLowerCase()) {
    const digit = hexadecimal ? '0123456789abcdef'.indexOf(character) : '0123456789'.indexOf(character);
    if (digit < 0) return undefined;
    code = code * (hexadecimal ? 16 : 10) + digit;
  }
  return code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
}

function descendants(node: Tree): Tree[] {
  const result: Tree[] = [];
  for (const child of node.children) {
    result.push(child, ...descendants(child));
  }
  return result;
}

function hasClass(node: Tree, name: string): boolean {
  return (node.attrs.class ?? '').split(' ').includes(name);
}

function textContent(node: Tree): string {
  return cleanText([...node.content, ...node.children.map(textContent)].join(' '));
}

function cleanText(value: string): string {
  let output = '';
  let pendingSpace = false;
  for (const character of decodeEntities(value)) {
    if (isSpace(character)) {
      pendingSpace = output.length > 0;
    } else {
      if (pendingSpace) output += ' ';
      output += character;
      pendingSpace = false;
    }
  }
  return output;
}

function filterUrls(base: string, query: string, preferredSort?: string): string[] {
  const sorts = [undefined, preferredSort, 'latest-updated', 'latest-added', 'score', 'name-az', 'release-date', 'most-viewed', 'number_of_episodes'];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const sort of sorts) {
    const key = sort ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    const url = new URL('/filter', base);
    url.searchParams.set('keyword', query);
    url.searchParams.set('type', '');
    url.searchParams.set('ep_min', '');
    url.searchParams.set('ep_max', '');
    if (sort) url.searchParams.set('sort', sort);
    urls.push(url.toString());
  }
  return urls;
}

function parseSearch(base: string, html: string): SearchResult[] {
  const root = htmlTree(html);
  const baseUrl = new URL(base);
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const list of descendants(root).filter((node) => node.attrs.id === 'list-items')) {
    for (const item of descendants(list).filter((node) => hasClass(node, 'item'))) {
      const anchor = descendants(item).find((node) => node.tag === 'a' && node.attrs.href !== undefined);
      if (!anchor) continue;
      let url: URL;
      try { url = new URL(anchor.attrs.href, baseUrl); } catch { continue; }
      if (url.protocol !== 'https:' || url.host !== baseUrl.host) continue;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'watch' || !parts[1] || !validSlug(parts[1]) || seen.has(parts[1])) continue;
      seen.add(parts[1]);
      const titleNode = descendants(item).find((node) => hasClass(node, 'name') || hasClass(node, 'd-title'));
      const title = titleNode ? textContent(titleNode) : parts[1].split('-').join(' ');
      results.push({ id: encodeCzId({ slug: parts[1], title }), name: title, episodes: 0, provider: 'anikoto2' });
    }
  }
  return results;
}

function parseShow(base: string, html: string): { showId: string; canonical: string } {
  const root = htmlTree(html);
  const element = descendants(root).find((node) => node.attrs.id === 'watch-main');
  const showId = element?.attrs['data-id'] ?? '';
  if (!showId || !onlyDigits(showId)) throw new Error('show page exposed an invalid catalog ID');
  const baseUrl = new URL(base);
  const canonical = new URL(element?.attrs['data-url'] ?? '', baseUrl);
  if (canonical.protocol !== 'https:' || canonical.host !== baseUrl.host) throw new Error('show page exposed an invalid canonical URL');
  let canonicalText = canonical.toString();
  while (canonicalText.endsWith('/')) canonicalText = canonicalText.slice(0, -1);
  return { showId, canonical: canonicalText };
}

function onlyDigits(value: string): boolean {
  return value.length > 0 && [...value].every((character) => character >= '0' && character <= '9');
}

function normalizeEpisode(value: string): string {
  const number = Number(value.trim());
  if (!Number.isFinite(number) || number < 0) throw new Error('invalid episode number');
  return Number.isInteger(number) ? String(number) : String(number);
}

function parseEpisodes(html: string): EpisodeRow[] {
  const root = htmlTree(html);
  const episodes: EpisodeRow[] = [];
  const seen = new Set<string>();
  for (const element of descendants(root)) {
    if (element.tag !== 'a' || element.attrs['data-num'] === undefined || element.attrs['data-ids'] === undefined) continue;
    let number: string;
    try { number = normalizeEpisode(element.attrs['data-num']); } catch { continue; }
    if (seen.has(number)) continue;
    seen.add(number);
    episodes.push({
      number,
      slug: element.attrs['data-slug'] ?? number,
      token: element.attrs['data-ids'] ?? '',
      malId: element.attrs['data-mal'] ?? '',
      timestamp: element.attrs['data-timestamp'] ?? '',
      sub: element.attrs['data-sub'] === '1',
      dub: element.attrs['data-dub'] === '1',
    });
  }
  episodes.sort((a, b) => Number(a.number) - Number(b.number));
  return episodes;
}

function providerResult(value: any, context: string): any {
  if (value?.status !== 200) throw new Error(`invalid Anikoto.cz ${context} response: ${value?.message ?? context}`);
  if (value.result === undefined) throw new Error(`${context} response has no result`);
  return value.result;
}

function parseServers(html: string, mode: Mode): Server[] {
  const root = htmlTree(html);
  const servers: Server[] = [];
  const seen = new Set<string>();
  for (const group of descendants(root).filter((node) => node.tag === 'div' && hasClass(node, 'type'))) {
    const typeName = group.attrs['data-type'] ?? '';
    const label = textContent(descendants(group).find((node) => node.tag === 'label') ?? group);
    const kind = serverKind(typeName, label);
    if ((mode === 'dub') !== (kind === 'dub')) continue;
    for (const item of descendants(group).filter((node) => node.tag === 'li' && node.attrs['data-link-id'] !== undefined)) {
      const token = item.attrs['data-link-id'];
      if (!token || seen.has(token)) continue;
      seen.add(token);
      const name = textContent(item) || 'Server';
      servers.push({ label: `${kind === 'hsub' ? 'H-SUB' : kind.toUpperCase()} · ${name}`, token });
    }
  }
  return servers;
}

function serverKind(typeName: string, label: string): 'sub' | 'hsub' | 'dub' {
  const tokens = `${typeName} ${label}`.toLowerCase().split('').map((character) => isWord(character) ? character : ' ').join('').split(' ').filter(Boolean);
  const has = (...values: string[]) => values.some((value) => tokens.includes(value));
  if (typeName.toLowerCase() === 'dub' || has('adub', 'dub', 'hdub') || (has('a') && has('dub'))) return 'dub';
  if (typeName.toLowerCase() === 'hsub' || has('hsub') || (has('h') && has('sub'))) return 'hsub';
  return 'sub';
}

function isWord(character: string): boolean {
  return (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');
}

function parseMapper(value: any, mode: Mode): Server[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const labels: Record<string, string> = { gogoanime: 'Vidstream', animepahe: 'Kiwi-Stream', anivibe: 'Vibe-Stream' };
  const servers: Server[] = [];
  for (const [provider, item] of Object.entries(value)) {
    if (provider === 'status') continue;
    const token = (item as any)?.[mode]?.url;
    if (typeof token !== 'string') continue;
    servers.push({ label: `${mode === 'dub' ? 'A-DUB' : 'H-SUB'} · ${labels[provider] ?? provider}`, token });
  }
  return servers;
}

function parseCzDataId(html: string): string | undefined {
  for (const node of descendants(htmlTree(html))) {
    const value = node.attrs['data-id'];
    if (value && onlyDigits(value)) return value;
  }
  return undefined;
}

function parseSources(payload: any): { sources: [string, string][]; subtitles: Subtitle[] } {
  const sources: [string, string][] = [];
  const visitSource = (value: any): void => {
    if (typeof value === 'string') {
      sources.push([value, 'Auto']);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visitSource);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const url = [value.file, value.url, value.src].find((item) => typeof item === 'string');
    if (url) {
      const label = [value.label, value.quality].find((item) => typeof item === 'string') ?? 'Auto';
      sources.push([url, cleanText(label)]);
    }
    let nested = false;
    for (const key of ['sources', 'source', 'links']) {
      if (value[key] !== undefined) {
        visitSource(value[key]);
        nested = true;
      }
    }
    if (!nested && !['file', 'url', 'src'].some((key) => key in value)) Object.values(value).forEach(visitSource);
  };

  const subtitles: Subtitle[] = [];
  const visitTracks = (value: any): void => {
    if (Array.isArray(value)) {
      value.forEach(visitTracks);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const kind = String(value.kind ?? value.type ?? '').toLowerCase();
    if (kind && !kind.includes('caption') && !kind.includes('subtitle') && !kind.includes('sub')) return;
    const url = [value.file, value.src, value.url].find((item) => typeof item === 'string');
    if (url && isSafeRemoteUrl(url)) {
      subtitles.push({ label: cleanText(value.label ?? value.title ?? 'Unknown'), url, default: value.default === true });
    }
  };
  if (payload?.sources !== undefined) visitSource(payload.sources);
  if (payload?.source !== undefined) visitSource(payload.source);
  for (const key of ['tracks', 'captions', 'subtitles']) if (payload?.[key] !== undefined) visitTracks(payload[key]);

  const uniqueSources: [string, string][] = [];
  const seenSource = new Set<string>();
  for (const entry of sources) {
    if (isSafeRemoteUrl(entry[0]) && !seenSource.has(entry[0])) {
      seenSource.add(entry[0]);
      uniqueSources.push(entry);
    }
  }
  const uniqueSubtitles: Subtitle[] = [];
  const seenSubtitle = new Set<string>();
  for (const track of subtitles) {
    if (!seenSubtitle.has(track.url)) {
      seenSubtitle.add(track.url);
      uniqueSubtitles.push(track);
    }
  }
  return { sources: uniqueSources, subtitles: uniqueSubtitles };
}

function isSafeRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !isIpLiteral(url.hostname);
  } catch {
    return false;
  }
}

function isIpLiteral(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return true;
  const pieces = host.split('.');
  return pieces.length === 4 && pieces.every((part) => onlyDigits(part) && Number(part) <= 255);
}

function parseJsString(source: string, quoteIndex: number): { value: string; next: number } | undefined {
  const quote = source[quoteIndex];
  if (quote !== '"' && quote !== "'") return undefined;
  let index = quoteIndex + 1;
  let escaped = false;
  for (; index < source.length; index++) {
    if (escaped) escaped = false;
    else if (source[index] === '\\') escaped = true;
    else if (source[index] === quote) break;
  }
  if (index >= source.length) return undefined;
  const raw = source.slice(quoteIndex, index + 1);
  try {
    const value = quote === '"' ? JSON.parse(raw) as string : JSON.parse(`"${raw.slice(1, -1).replaceAll('"', '\\"')}"`) as string;
    return { value, next: index + 1 };
  } catch {
    return { value: raw.slice(1, -1), next: index + 1 };
  }
}

function playerParameters(script: string): { key: string; iv: string; secret: string; ttl: number } {
  let constIndex = script.indexOf('const ');
  while (constIndex >= 0) {
    let cursor = constIndex + 6;
    const strings: string[] = [];
    let valid = true;
    for (let part = 0; part < 3; part++) {
      while (cursor < script.length && script[cursor] !== '=') cursor++;
      if (cursor >= script.length) { valid = false; break; }
      const parsed = parseJsString(script, cursor + 1);
      if (!parsed) { valid = false; break; }
      strings.push(parsed.value);
      cursor = parsed.next;
      while (cursor < script.length && script[cursor] !== ',') cursor++;
      if (cursor >= script.length) { valid = false; break; }
      cursor++;
    }
    let ttl = '';
    if (valid) {
      while (cursor < script.length && script[cursor] !== '=') cursor++;
      if (cursor < script.length) {
        cursor++;
        while (cursor < script.length && script[cursor] >= '0' && script[cursor] <= '9') ttl += script[cursor++];
      }
    }
    const window = script.slice(cursor, cursor + 2500);
    if (valid && strings.length === 3 && ttl && window.includes('AES-CBC')) {
      return { key: strings[0], iv: strings[1], secret: strings[2], ttl: Number(ttl) };
    }
    const next = script.indexOf('const ', constIndex + 6);
    constIndex = next;
  }
  throw new Error('Player crypto parameters changed; update playerParameters().');
}

function base64UrlDecode(value: string): CryptoJS.lib.WordArray {
  let base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  while (base64.length % 4 !== 0) base64 += '=';
  return CryptoJS.enc.Base64.parse(base64);
}

function decryptSource(encoded: string, key: string, iv: string): any {
  const keyBytes = CryptoJS.enc.Utf8.parse(key.padEnd(32, '\0').slice(0, 32));
  const ivBytes = CryptoJS.enc.Utf8.parse(iv.padEnd(16, '\0').slice(0, 16));
  const decrypted = CryptoJS.AES.decrypt({ ciphertext: base64UrlDecode(encoded) } as CryptoJS.lib.CipherParams, keyBytes, {
    iv: ivBytes,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  }).toString(CryptoJS.enc.Utf8);
  if (!decrypted) throw new Error('Decryption failed');
  try { return JSON.parse(decrypted); } catch { throw new Error('Invalid JSON in decrypted data'); }
}

function signedUrl(value: string, secret: string, ttl: number): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.searchParams.has('token')) return value;
  const segments = url.pathname.split('/').filter(Boolean);
  let pair: [string, string] | undefined;
  for (let index = 0; index < segments.length - 1; index++) {
    if (segments[index].length === 32 && segments[index + 1].length === 32 && isHex(segments[index]) && isHex(segments[index + 1])) {
      pair = [segments[index].toLowerCase(), segments[index + 1].toLowerCase()];
      break;
    }
  }
  if (!pair) return undefined;
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const message = `${expires}|${pair[0]}/${pair[1]}`;
  const signature = CryptoJS.HmacSHA256(message, secret).toString(CryptoJS.enc.Base64).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const encodedMessage = CryptoJS.enc.Utf8.parse(message).toString(CryptoJS.enc.Base64).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  url.searchParams.append('token', `${encodedMessage}.${signature}`);
  return url.toString();
}

function isHex(value: string): boolean {
  return [...value.toLowerCase()].every((character) => (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'));
}

function signSourceUrls(value: any, secret: string, ttl: number): void {
  if (typeof value === 'string') return;
  if (Array.isArray(value)) {
    value.forEach((item) => signSourceUrls(item, secret, ttl));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'file' || key === 'url' || key === 'src') && typeof child === 'string') {
      value[key] = signedUrl(child, secret, ttl) ?? child;
    } else signSourceUrls(child, secret, ttl);
  }
}

export class AnikotoCzClient {
  private readonly base: string;
  private readonly mapperBase: string;
  private readonly userAgent: string;
  private readonly seriesCache = new Map<string, CacheEntry<Series>>();

  constructor(options: { base?: string; mapperBase?: string; userAgent?: string } = {}) {
    let base = options.base ?? BASE;
    while (base.endsWith('/')) base = base.slice(0, -1);
    let mapperBase = options.mapperBase ?? MAPPER_BASE;
    while (mapperBase.endsWith('/')) mapperBase = mapperBase.slice(0, -1);
    this.base = base;
    this.mapperBase = mapperBase;
    this.userAgent = options.userAgent ?? CZ_UA;
  }

  async search(query: string, sort?: string): Promise<SearchResult[]> {
    const cleaned = query.trim();
    if (!cleaned) throw new Error('empty search query');
    const urls = filterUrls(this.base, cleaned, sort);
    const ajax = new URL('/ajax/anime/search', this.base);
    ajax.searchParams.set('keyword', cleaned);
    urls.push(ajax.toString());
    for (const url of urls) {
      try {
        let html: string;
        if (url.includes('/filter')) html = await this.getText(url, this.base, false);
        else {
          const payload = await this.getJson(url, this.base, true);
          const result = providerResult(payload, 'search');
          html = typeof result === 'string' ? result : typeof result?.html === 'string' ? result.html : '';
          if (!html) continue;
        }
        const results = parseSearch(this.base, html);
        if (results.length) return results;
      } catch {
        continue;
      }
    }
    return [];
  }

  async episodes(showId: string, mode: Mode): Promise<string[]> {
    const id = decodeCzId(showId);
    const series = await this.loadSeries(id.slug);
    const episodes = series.episodes.filter((episode) => mode === 'sub' ? episode.sub : episode.dub).map((episode) => episode.number);
    episodes.sort((a, b) => Number(a) - Number(b));
    if (!episodes.length) throw new Error(`Anikoto.cz has no ${mode} episodes for ${id.title}`);
    return episodes;
  }

  async episodeList(showId: string): Promise<Episode[]> {
    const id = decodeCzId(showId);
    const series = await this.loadSeries(id.slug);
    if (!series.episodes.length) throw new Error('No episodes are available');
    return series.episodes.map((episode) => ({
      number: episode.number,
      title: `Episode ${episode.number}`,
      raw: { ...episode },
    }));
  }

  async streams(showId: string, episode: string, mode: Mode): Promise<Stream[]> {
    const id = decodeCzId(showId);
    const series = await this.loadSeries(id.slug);
    const number = normalizeEpisode(episode);
    const selected = series.episodes.find((item) => item.number === number);
    if (!selected) throw new Error(`episode ${episode} is not available for this anime`);
    const available = mode === 'sub' ? selected.sub : selected.dub;
    if (!available) throw new Error(`Anikoto.cz has no ${mode} episodes for ${id.title}`);

    const episodeUrl = `${series.canonical}/ep-${encodeURIComponent(selected.slug)}`;
    await this.getText(episodeUrl, series.canonical, false);
    const serverUrl = new URL('/ajax/server/list', this.base);
    serverUrl.searchParams.set('servers', selected.token);
    const payload = await this.getJson(serverUrl.toString(), episodeUrl, true);
    const markup = providerResult(payload, 'server list');
    if (typeof markup !== 'string') throw new Error('server list contained no markup');
    const servers = parseServers(markup, mode);
    servers.push(...await this.mapperServers(selected, mode));
    const uniqueServers = servers.filter((server, index) => servers.findIndex((other) => other.token === server.token) === index);
    const streams: Stream[] = [];
    const failures: string[] = [];
    for (const server of uniqueServers) {
      try {
        const embed = await this.resolveServer(server, episodeUrl);
        streams.push(...await this.extractNative(embed, server.label, episodeUrl, mode));
      } catch (error) {
        if (error instanceof RateLimitedError) throw error;
        failures.push(`${server.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const unique = streams.filter((stream, index) => streams.findIndex((other) => other.url === stream.url) === index);
    sortStreams(unique);
    if (!unique.length) {
      const detail = failures.length ? failures.join('; ') : 'no supported native servers were returned';
      console.warn(`Anikoto.cz native source resolution failed: ${detail}`);
      throw new Error(`no playable sources for ${id.title} episode ${episode} (${mode})`);
    }
    return unique;
  }

  async expandStreamQualities(stream: Stream): Promise<Stream[]> {
    if (!stream.hls) return [stream];
    const variants = await this.expandHls(stream.url, stream.headers);
    const expanded = variants.map((variant) => ({
      ...stream,
      url: variant.url,
      resolution: variant.resolution === 'Auto' ? stream.resolution : variant.resolution,
    }));
    return expanded.length ? expanded : [stream];
  }

  private async loadSeries(slug: string): Promise<Series> {
    if (!validSlug(slug)) throw new Error('invalid Anikoto.cz show slug');
    const cached = this.seriesCache.get(slug);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (cached) this.seriesCache.delete(slug);
    const showHtml = await this.getText(`${this.base}/watch/${slug}`, this.base, false);
    const { showId, canonical } = parseShow(this.base, showHtml);
    const listUrl = new URL(`/ajax/episode/list/${showId}`, this.base);
    listUrl.searchParams.set('style', 'grid');
    listUrl.searchParams.set('vrf', '');
    const payload = await this.getJson(listUrl.toString(), canonical, true);
    const markup = providerResult(payload, 'episode list');
    if (typeof markup !== 'string') throw new Error('episode list contained no markup');
    const episodes = parseEpisodes(markup);
    if (!episodes.length) throw new Error('No episodes are available');
    const series = { canonical, episodes };
    if (this.seriesCache.size >= 100) this.seriesCache.delete(this.seriesCache.keys().next().value!);
    this.seriesCache.set(slug, { expires: Date.now() + CACHE_MS, value: series });
    return series;
  }

  private async mapperServers(episode: EpisodeRow, mode: Mode): Promise<Server[]> {
    if (!episode.malId || !episode.timestamp) return [];
    const url = `${this.mapperBase}/${encodeURIComponent(episode.malId)}/${encodeURIComponent(episode.slug)}/${encodeURIComponent(episode.timestamp)}`;
    try { return parseMapper(await this.getJson(url, this.base, false), mode); } catch { return []; }
  }

  private async resolveServer(server: Server, episodeUrl: string): Promise<string> {
    const url = new URL('/ajax/server', this.base);
    url.searchParams.set('get', server.token);
    const payload = await this.getJson(url.toString(), episodeUrl, true);
    const result = providerResult(payload, 'server');
    const raw = typeof result === 'string' ? result : result?.url;
    if (typeof raw !== 'string') throw new Error('server returned no embed URL');
    if (!isSafeRemoteUrl(raw)) throw new Error('unsafe provider URL');
    return raw;
  }

  private async extractNative(embedUrl: string, provider: string, episodeUrl: string, mode: Mode): Promise<Stream[]> {
    if (!isSafeRemoteUrl(embedUrl)) throw new Error('unsafe provider URL');
    const embed = new URL(embedUrl);
    const supported = ['megaplay.buzz', 'vidtube.site', 'megap.shiora.top', 'shiora.top', 'megap.kotocdn.site', 'megap.akirax.buzz', 'akirax.buzz'];
    if (!supported.some((domain) => hostMatches(embed.hostname, domain))) throw new Error(`unsupported embed host: ${embed.hostname}`);
    const origin = embed.origin;
    const html = await this.getText(embedUrl, episodeUrl, false);
    const dataId = parseCzDataId(html);
    if (!dataId) throw new Error('embed did not expose a playable source id');
    const payload = await this.getNativeSources(origin, embedUrl, dataId, mode, html);
    const { sources, subtitles } = parseSources(payload);
    if (!sources.length) throw new Error(`No native streams from ${embed.hostname}`);
    const headers = { Referer: `${origin}/`, Origin: origin, 'User-Agent': this.userAgent };
    const streams: Stream[] = [];
    for (const [url, label] of sources) {
      const parsed = new URL(url);
      const hls = parsed.pathname.toLowerCase().includes('.m3u8') || (parsed.search.includes('.m3u8'));
      const variants = [{ resolution: label, url }];
      for (const variant of variants) {
        streams.push({ url: variant.url, resolution: variant.resolution.toLowerCase() === 'auto' ? label : variant.resolution, hls, headers, subtitles, provider, downloadable: true });
      }
    }
    return streams;
  }

  private async getNativeSources(origin: string, embedUrl: string, dataId: string, mode: Mode, html: string): Promise<any> {
    const sourceUrl = new URL('/stream/getSourcesNew', origin);
    sourceUrl.searchParams.set('id', dataId);
    sourceUrl.searchParams.set('type', mode);
    const response = await this.request(sourceUrl.toString(), embedUrl, true, origin);
    const raw = await this.checkedText(response);
    let payload: any;
    try { payload = JSON.parse(raw); } catch { throw new Error('provider returned invalid JSON'); }
    if (typeof payload?.enc === 'string') {
      const scriptNode = descendants(htmlTree(html)).find((node) => node.tag === 'script' && (node.attrs.src ?? '').includes('e1-player'));
      let scriptUrl = scriptNode?.attrs.src;
      if (!scriptUrl) throw new Error('Missing e1-player script');
      if (scriptUrl.startsWith('//')) scriptUrl = `https:${scriptUrl}`;
      else if (scriptUrl.startsWith('/')) scriptUrl = `${origin}${scriptUrl}`;
      const js = await this.getText(scriptUrl, embedUrl, false);
      const params = playerParameters(js);
      const decrypted = decryptSource(payload.enc, params.key, params.iv);
      signSourceUrls(decrypted, params.secret, params.ttl);
      payload.sources = decrypted;
    }
    return payload;
  }

  private async expandHls(url: string, headers: Record<string, string>): Promise<{ resolution: string; url: string }[]> {
    const response = await this.request(url, headers.Referer ?? this.base, false, headers.Origin);
    if (!response.ok) return [{ resolution: 'Auto', url }];
    const text = await this.checkedText(response, 4 * 1024 * 1024);
    if (!text.trimStart().startsWith('#EXTM3U') || !text.includes('#EXT-X-STREAM-INF')) return [{ resolution: 'Auto', url }];
    const lines = text.split('\n');
    const variants: { resolution: string; url: string }[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const resolution = readResolution(line) ?? 'Auto';
      for (let next = index + 1; next < lines.length; next++) {
        const path = lines[next].trim();
        if (!path || path.startsWith('#')) continue;
        variants.push({ resolution, url: new URL(path, url).toString() });
        break;
      }
    }
    return variants.length ? variants : [{ resolution: 'Auto', url }];
  }

  private async getJson(url: string, referer: string, ajax: boolean, origin?: string): Promise<any> {
    const response = await this.request(url, referer, ajax, origin);
    const text = await this.checkedText(response);
    try { return JSON.parse(text); } catch { throw new Error('provider returned invalid JSON'); }
  }

  private async getText(url: string, referer: string, ajax: boolean): Promise<string> {
    return this.checkedText(await this.request(url, referer, ajax));
  }

  private async request(url: string, referer: string, ajax: boolean, origin?: string): Promise<Response> {
    const headers: Record<string, string> = {
      Referer: referer,
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': this.userAgent,
      Accept: ajax ? 'application/json, text/javascript, */*; q=0.01' : 'text/html,application/xhtml+xml,*/*;q=0.8',
      ...(ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
      ...(origin ? { Origin: origin } : {}),
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      return await fetch(url, { headers, credentials: 'include', signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async checkedText(response: Response, maxBytes = MAX_BYTES): Promise<string> {
    if (response.status === 429) throw new RateLimitedError('Anikoto.cz', Number(response.headers.get('retry-after')) || 120);
    if (!response.ok) throw new Error(`Anikoto.cz HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) throw new Error(`Anikoto.cz response exceeds ${maxBytes} bytes`);
    const text = await response.text();
    if (utf8Bytes(text).length > maxBytes) throw new Error(`Anikoto.cz response exceeds ${maxBytes} bytes`);
    return text;
  }
}

function hostMatches(host: string, domain: string): boolean {
  let normalized = host.toLowerCase();
  while (normalized.endsWith('.')) normalized = normalized.slice(0, -1);
  return normalized === domain || normalized.endsWith(`.${domain}`);
}

function readResolution(line: string): string | undefined {
  const start = line.indexOf('RESOLUTION=');
  if (start < 0) return undefined;
  const dimension = line.slice(start + 11).split(',')[0];
  const x = dimension.indexOf('x');
  if (x < 0) return undefined;
  const height = dimension.slice(x + 1);
  return onlyDigits(height) ? `${height}p` : undefined;
}

function qualityNumber(label: string): number {
  let digits = '';
  for (const character of label) {
    if (character >= '0' && character <= '9') digits += character;
    else if (digits) break;
  }
  return Number(digits) || 0;
}
