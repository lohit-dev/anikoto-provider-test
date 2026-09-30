import { afterEach, describe, expect, test } from 'bun:test';
import { AnimeLokClient, ANIMELOK_BASE_URL } from './animelok.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const text = (value, status = 200) => new Response(value, { status });
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('AnimeLok episode catalog', () => {
  test('loads AniList keyed RSC episodes, total and thumbnail fields', async () => {
    let requestedUrl;
    let requestedHeaders;
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init.headers);
      return text(`1:${JSON.stringify({ props: { watch: {
        totalEpisodes: 24,
        episodes: [{ number: 1, title: 'Departure', image: 'https://img.example/1.jpg', airdate: '2026-01-02' }],
      } } })}`);
    };

    const client = new AnimeLokClient();
    const result = await client.scrapeEpisodes('21');
    expect(requestedUrl).toBe(`${ANIMELOK_BASE_URL}/watch/21`);
    expect(requestedHeaders.get('rsc')).toBe('1');
    expect(result).toEqual({ episodes: [{
      number: 1,
      name: 'Departure',
      title: 'Departure',
      airdate: '2026-01-02',
      thumbnail: 'https://img.example/1.jpg',
      image: 'https://img.example/1.jpg',
      img: 'https://img.example/1.jpg',
    }], total: 24 });
  });

  test('reports absent episode pages and unexpected HTTP failures', async () => {
    globalThis.fetch = async () => text('missing', 404);
    await expect(new AnimeLokClient().scrapeEpisodes('21')).rejects.toThrow('animelok responded 404');
    globalThis.fetch = async () => text('broken', 503);
    await expect(new AnimeLokClient().scrapeEpisodes('21')).rejects.toThrow('animelok responded 503');
  });
});

describe('AnimeLok stream catalog', () => {
  test('normalizes sub and dub embeds, server labels, video hash and dub query', async () => {
    let requestedUrl;
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return json({ servers: [
        { server: 'default', type: 'sub', url: 'https://short.icu/embed-key' },
        { source: 'reanime', server: 'reanime', type: 'dub', url: 'https://player.example/video/abc123' },
        { server: 'multi-lang', language: 'Japanese', url: 'https://other.example/embed' },
        { server: 'dub-only', type: 'dub', url: 'https://dub.example/embed' },
        { server: 'no-url', type: 'sub' },
      ] });
    };

    const result = await new AnimeLokClient().scrapeStream('21', '3');
    expect(requestedUrl).toBe(`${ANIMELOK_BASE_URL}/api/anilist/21/3`);
    expect(result.sub.embeds).toEqual([
      { url: 'https://player.abyssplayer.com/embed-key', server: 'multi' },
      { url: 'https://other.example/embed', server: 'Japanese' },
    ]);
    expect(result.sub.hash).toBeNull();
    expect(result.sub.best).toBe('https://player.abyssplayer.com/embed-key');
    expect(result.dub.embeds).toEqual([
      { url: 'https://player.example/video/abc123?a=1', server: 'reanime' },
      { url: 'https://other.example/embed', server: 'Japanese' },
      { url: 'https://dub.example/embed', server: 'dub-only' },
    ]);
    expect(result.dub.hash).toBe('abc123');
    expect(result.dub.best).toBe(result.dub.embeds[0].url);
  });

  test('treats missing episode streams as unavailable and reports other failures', async () => {
    globalThis.fetch = async () => text('', 502);
    expect(await new AnimeLokClient().scrapeStream('21', '4')).toBeNull();
    globalThis.fetch = async () => text('', 500);
    await expect(new AnimeLokClient().scrapeStream('21', '4')).rejects.toThrow('animelok responded 500');
  });
});
