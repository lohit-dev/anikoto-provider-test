import CryptoJS from 'crypto-js';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  AnikotoClient,
  decodeId,
  encodeId,
  parseDataId,
  parseDetails,
  parseEpisodePayload,
  parseMegaplaySources,
  parseSearchPayload,
  parseThumbnailVtt,
  embedCandidates,
  validateRemoteUrl,
  isMegaplayMediaHost,
  providerFromShowId,
  decodeCzId,
  encodeCzId,
  parseSearchSort,
  sortEpisodes,
  chooseQuality,
  expandEpisodeSelection,
  sortStreams,
} from './anikoto.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const text = (value, status = 200) => new Response(value, { status });

describe('IDs and provider routing', () => {
  test('round trips legacy metadata, accepts numeric IDs, and detects provider', () => {
    const metadata = { anilistId: '21', malId: '1535', anikotoId: '9', title: 'One Piece', episodes: 1000 };
    const encoded = encodeId(metadata);
    expect(decodeId(encoded)).toEqual(metadata);
    expect(decodeId('123')).toEqual({ anikotoId: '123' });
    expect(providerFromShowId(encoded)).toBe('anikoto');
    expect(providerFromShowId('anikoto2:metadata')).toBe('anikoto2');
  });

  test('round trips CZ IDs and accepts a raw show slug', () => {
    const metadata = { slug: 'code-geass-r1', title: 'Code Geass', episodes: 25 };
    const encoded = encodeCzId(metadata);
    expect(decodeCzId(encoded)).toEqual(metadata);
    expect(decodeCzId('code-geass-r1').slug).toBe('code-geass-r1');
    expect(providerFromShowId(encoded)).toBe('anikoto2');
  });
});

describe('shared model helpers', () => {
  test('parses provider search sort aliases', () => {
    expect(parseSearchSort('nameaz')).toBe('name-az');
    expect(parseSearchSort('number_of_episodes')).toBe('number_of_episodes');
    expect(() => parseSearchSort('random')).toThrow();
  });

  test('sorts fractional episode numbers and expands selections', () => {
    const episodes = ['10', '2.5', '1', '2'];
    sortEpisodes(episodes);
    expect(episodes).toEqual(['1', '2', '2.5', '10']);
    expect(expandEpisodeSelection('2-10', episodes)).toEqual(['2', '2.5', '10']);
    expect(expandEpisodeSelection('-1', episodes)).toEqual(['10']);
    expect(expandEpisodeSelection('1 2.5', episodes)).toEqual(['1', '2.5']);
    expect(() => expandEpisodeSelection('10-1', episodes)).toThrow();
  });

  test('chooses requested stream quality and falls back to best', () => {
    const streams = [
      { url: 'best', resolution: '1080p', hls: true, headers: {}, subtitles: [], provider: 'default' },
      { url: 'middle', resolution: '720p', hls: true, headers: {}, subtitles: [], provider: 'default' },
      { url: 'low', resolution: '480p', hls: true, headers: {}, subtitles: [], provider: 'default' },
    ];
    expect(chooseQuality(streams, 'worst').url).toBe('low');
    expect(chooseQuality(streams, '720').url).toBe('middle');
    expect(chooseQuality(streams, '1440p').url).toBe('best');
  });

  test('sorts streams by provider, resolution, then HLS preference', () => {
    const streams = [
      { url: 'auto', resolution: 'Auto', hls: true, headers: {}, subtitles: [], provider: 'Default' },
      { url: '480', resolution: '480p', hls: true, headers: {}, subtitles: [], provider: 'Default' },
      { url: 'mp4', resolution: '720p', hls: false, headers: {}, subtitles: [], provider: 'S-MP4' },
      { url: '720', resolution: '720p', hls: true, headers: {}, subtitles: [], provider: 'Default' },
    ];
    sortStreams(streams);
    expect(streams.map((stream) => stream.url)).toEqual(['mp4', '720', '480', 'auto']);
  });
});

describe('catalog and parsing flows', () => {
  test('parses AniList/recent results and filters adult entries by default', () => {
    const result = parseSearchPayload({ data: { Page: { media: [
      { id: 21, idMal: 1535, title: { english: 'One Piece', romaji: 'One Piece' }, episodes: 1000, isAdult: false },
      { id: 22, title: { english: 'Adult title' }, episodes: 1, isAdult: true },
    ] } } }, false);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('One Piece');
    expect(decodeId(result[0].id).anilistId).toBe('21');
  });

  test('parses details and episode payload while retaining upstream raw episode fields', () => {
    const details = parseDetails({ data: { Media: {
      id: 21, title: { english: 'One Piece' }, startDate: { year: 1999, month: 10 },
      genres: ['Adventure'], tags: [], studios: { nodes: [] }, streamingEpisodes: [], relations: { edges: [] },
    } } });
    expect(details.title.english).toBe('One Piece');
    expect(details.startDate).toBe('1999-10');
    const episodes = parseEpisodePayload({ data: { episodes: [
      { number: 2, title: 'Second', custom: 'kept' }, { episode: 1, embed_url: { sub: 'https://megaplay.buzz/e1' } },
    ] } });
    expect(episodes.map((episode) => episode.number)).toEqual(['1', '2']);
    expect(episodes[1].raw.custom).toBe('kept');
  });

  test('builds ordered legacy stream candidates and reads MegaPlay source/subtitle metadata', () => {
    const candidates = embedCandidates('https://megaplay.buzz', {
      anilistId: '21', malId: '1535',
    }, '1', 'sub', { number: '1', embedId: '44', subUrl: 'https://megaplay.buzz/direct' });
    expect(candidates).toEqual([
      'https://megaplay.buzz/direct',
      'https://megaplay.buzz/stream/s-2/44/sub',
      'https://megaplay.buzz/stream/ani/21/1/sub',
      'https://megaplay.buzz/stream/mal/1535/1/sub',
    ]);
    const parsed = parseMegaplaySources({
      sources: { links: [{ file: 'https://media.example/video.m3u8', label: '1080p' }] },
      tracks: [{ file: 'https://media.example/en.vtt', label: 'English', kind: 'captions', default: true }],
      intro: { start: 1, end: 2 },
    });
    expect(parsed.sources).toEqual([['https://media.example/video.m3u8', '1080p']]);
    expect(parsed.subtitles[0]).toEqual({ label: 'English', url: 'https://media.example/en.vtt', default: true });
    expect(parsed.intro).toEqual({ start: 1, end: 2 });
  });

  test('parses embed IDs and thumbnail cues, and rejects unsafe media URLs', () => {
    expect(parseDataId(`<div DATA-ID='42'></div>`)).toBe('42');
    const cues = parseThumbnailVtt('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nsprite.jpg#xywh=1,2,160,90', 'https://media.example/thumbs.vtt');
    expect(cues[0]).toEqual({ start: 0, end: 2, url: 'https://media.example/sprite.jpg', x: 1, y: 2, w: 160, h: 90 });
    expect(isMegaplayMediaHost('cdn.megaplay.buzz')).toBe(true);
    expect(isMegaplayMediaHost('evilmegaplay.buzz')).toBe(false);
    expect(() => validateRemoteUrl('http://example.com/video.mp4')).toThrow();
  });
});

test('search falls back to AniList when the Anikoto sources fail', async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://anikoto.cz/')) return text('unavailable', 503);
    if (url.includes('/recent-anime')) return text('unavailable', 503);
    if (url === 'https://graphql.test') {
      expect(init.method).toBe('POST');
      return json({ data: { Page: { media: [
        { id: 21, title: { english: 'One Piece' }, episodes: 1000, isAdult: false },
      ] } } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const client = new AnikotoClient({ anilistApi: 'https://graphql.test' });
  const results = await client.search('one piece');
  expect(results[0].name).toBe('One Piece');
  expect(decodeId(results[0].id).anilistId).toBe('21');
});

test('search keeps CZ playback IDs while enriching results with AniList artwork', async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'anikoto.cz' && url.pathname === '/filter') {
      return text('<div id="list-items"><div class="item"><a href="/watch/one-piece"><span class="name">One Piece</span></a></div></div>');
    }
    if (url.hostname === 'anikoto.cz' && url.pathname === '/recent-anime') return json({ data: [] });
    if (url.hostname === 'graphql.test') return json({ data: { Page: { media: [
      { id: 21, title: { english: 'One Piece' }, episodes: 1000, coverImage: { extraLarge: 'https://img.example/one-piece.jpg' }, isAdult: false },
    ] } } });
    throw new Error(`Unexpected URL ${url.toString()}`);
  };
  const client = new AnikotoClient({ anilistApi: 'https://graphql.test' });
  const results = await client.search('one piece');
  expect(results[0].id.startsWith('anikoto2:')).toBe(true);
  expect(results[0].cover).toBe('https://img.example/one-piece.jpg');
});

test('CZ details resolve their title through AniList and parse the resulting media', async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'graphql.test') {
      const body = JSON.parse(init?.body ?? '{}');
      if (body.query.includes('Media(')) return json({ data: { Media: {
        id: 21, idMal: 1535, title: { english: 'One Piece', romaji: 'One Piece' },
        synonyms: [], genres: ['Adventure'], tags: [], studios: { nodes: [] }, streamingEpisodes: [], relations: { edges: [] },
      } } });
      return json({ data: { Page: { media: [
        { id: 21, title: { english: 'One Piece', romaji: 'One Piece' }, episodes: 1000, isAdult: false },
      ] } } });
    }
    throw new Error(`Unexpected URL ${url.toString()}`);
  };
  const client = new AnikotoClient({ anilistApi: 'https://graphql.test' });
  const details = await client.details(encodeCzId({ slug: 'one-piece', title: 'One Piece' }));
  expect(details.anilistId).toBe('21');
  expect(details.title.english).toBe('One Piece');
});

test('legacy episode count fallback and AniList-to-MAL stream fallback still work', async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'megaplay.test' && url.pathname === '/stream/ani/21/1/sub') return text('missing', 404);
    if (url.hostname === 'megaplay.test' && url.pathname === '/stream/mal/1535/1/sub') return text('<div data-id="77"></div>');
    if (url.hostname === 'megaplay.test' && url.pathname === '/stream/getSources') return json({ sources: { file: 'https://cdn.example/episode.mp4' } });
    throw new Error(`Unexpected URL ${url.toString()}`);
  };
  const client = new AnikotoClient({ megaplayBase: 'https://megaplay.test' });
  const showId = encodeId({ anilistId: '21', malId: '1535', episodes: 2, title: 'Example' });
  expect(await client.episodes(showId)).toEqual(['1', '2']);
  const streams = await client.streams(showId, '1', 'sub');
  expect(streams).toHaveLength(1);
  expect(streams[0].url).toBe('https://cdn.example/episode.mp4');
  expect(streams[0].hls).toBe(false);
});

test('bare AniList ID loads its episode count from AniList, then resolves an episode link', async () => {
  const requested = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requested.push(url.toString());
    if (url.hostname === 'graphql.test') {
      const body = JSON.parse(init?.body ?? '{}');
      expect(body.variables.id).toBe(21);
      return json({ data: { Media: {
        id: 21, title: { english: 'One Piece' }, episodes: 2,
        synonyms: [], genres: [], tags: [], studios: { nodes: [] }, streamingEpisodes: [], relations: { edges: [] },
      } } });
    }
    if (url.hostname === 'megaplay.test' && url.pathname === '/stream/ani/21/1/sub') {
      return text('<div data-id="88"></div>');
    }
    if (url.hostname === 'megaplay.test' && url.pathname === '/stream/getSources') {
      expect(url.searchParams.get('id')).toBe('88');
      return json({ sources: { file: 'https://cdn.example/anilist-only-episode-1.mp4' } });
    }
    throw new Error(`Unexpected URL ${url.toString()}`);
  };
  const client = new AnikotoClient({ anilistApi: 'https://graphql.test', megaplayBase: 'https://megaplay.test' });
  const anilistOnlyShowId = encodeId({ anilistId: '21', title: 'One Piece' });

  expect(await client.episodes(anilistOnlyShowId)).toEqual(['1', '2']);
  expect(requested.some((url) => new URL(url).hostname === 'graphql.test')).toBe(true);
  const streams = await client.streams(anilistOnlyShowId, '1', 'sub');
  expect(requested.some((url) => url.includes('/stream/ani/21/1/sub'))).toBe(true);
  expect(streams[0].url).toBe('https://cdn.example/anilist-only-episode-1.mp4');
});

test('CZ playback resolves encrypted source payload to a signed HLS URL, then discovers qualities', async () => {
  const slug = 'code-geass-r1';
  const showId = encodeCzId({ slug, title: 'Code Geass' });
  const key = '12345678901234567890123456789012';
  const iv = '1234567890123456';
  const secret = 'test-signing-secret';
  const expires = Math.floor(Date.now() / 1000) + 90;
  const mediaPath = `/anime/${'a'.repeat(32)}/${'b'.repeat(32)}/master.m3u8`;
  const encryptedSource = { file: `https://fetch.example${mediaPath}` };
  const ciphertext = CryptoJS.AES.encrypt(JSON.stringify(encryptedSource), CryptoJS.enc.Utf8.parse(key), {
    iv: CryptoJS.enc.Utf8.parse(iv), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7,
  }).ciphertext.toString(CryptoJS.enc.Base64).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  let sourceQuery;
  let sawHeaders = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    if (url.hostname === 'anikoto.cz' && url.pathname === `/watch/${slug}`) {
      return text(`<div id="watch-main" data-id="88" data-url="/watch/${slug}"></div>`);
    }
    if (url.hostname === 'anikoto.cz' && url.pathname === '/ajax/episode/list/88') {
      return json({ status: 200, result: '<a data-num="1" data-slug="1" data-ids="episode-token" data-sub="1" data-dub="1"></a>' });
    }
    if (url.hostname === 'anikoto.cz' && url.pathname.endsWith('/ep-1')) return text('<html>episode</html>');
    if (url.hostname === 'anikoto.cz' && url.pathname === '/ajax/server/list') {
      return json({ status: 200, result: '<div class="type" data-type="sub"><label>SUB</label><ul><li data-link-id="server-token">Stream</li></ul></div>' });
    }
    if (url.hostname === 'anikoto.cz' && url.pathname === '/ajax/server') {
      return json({ status: 200, result: { url: 'https://megaplay.buzz/embed/episode' } });
    }
    if (url.hostname === 'mapper.nekostream.site') return json({});
    if (url.hostname === 'megaplay.buzz' && url.pathname === '/embed/episode') {
      return text('<div data-id="42"></div><script src="/lib/e1-player.min.js"></script>');
    }
    if (url.hostname === 'megaplay.buzz' && url.pathname === '/stream/getSourcesNew') {
      sourceQuery = { id: url.searchParams.get('id'), type: url.searchParams.get('type') };
      sawHeaders = headers.get('referer') === 'https://megaplay.buzz/embed/episode'
        && headers.get('origin') === 'https://megaplay.buzz'
        && headers.get('x-requested-with') === 'XMLHttpRequest';
      return json({ enc: ciphertext, tracks: [{ file: 'https://sub.example/en.vtt', label: 'English', kind: 'captions', default: true }] });
    }
    if (url.hostname === 'megaplay.buzz' && url.pathname === '/lib/e1-player.min.js') {
      return text(`const a="${key}",b="${iv}",c="${secret}",d=90;function x(){AES-CBC}`);
    }
    if (url.hostname === 'fetch.example' && url.pathname === mediaPath) {
      return text('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n1080/playlist.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720\n720/playlist.m3u8\n');
    }
    throw new Error(`Unexpected URL ${url.toString()}`);
  };

  const client = new AnikotoClient();
  const episodes = await client.episodeList(showId);
  expect(episodes.map((episode) => episode.number)).toEqual(['1']);
  const streams = await client.streams(showId, '1', 'sub');
  expect(sourceQuery).toEqual({ id: '42', type: 'sub' });
  expect(sawHeaders).toBe(true);
  expect(streams).toHaveLength(1);
  expect(streams[0].hls).toBe(true);
  expect(streams[0].url).toContain(mediaPath);
  expect(new URL(streams[0].url).searchParams.has('token')).toBe(true);
  expect(streams[0].subtitles[0].url).toBe('https://sub.example/en.vtt');
  expect(streams[0].headers.Referer).toBe('https://megaplay.buzz/');

  const qualities = await client.discoverQualities(streams[0]);
  expect(qualities.map((stream) => stream.resolution)).toEqual(['1080p', '720p']);
  expect(qualities[0].url).toBe('https://fetch.example/anime/' + 'a'.repeat(32) + '/' + 'b'.repeat(32) + '/1080/playlist.m3u8');
  expect(qualities[0].subtitles[0].label).toBe('English');
});
