import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useVideoPlayer, VideoView } from 'expo-video';
import { WebView } from 'react-native-webview';
import { anikoto, animelok } from '../src/services/client';
import { friendlyError } from '../src/services/errors';
import type { Mode, Stream, Subtitle } from '../src/services/anikoto';

const colors = { bg: '#101116', panel: '#1b1c24', text: '#f4f3f8', muted: '#a4a4b1', accent: '#b6a1ff' };

export default function PlayerScreen() {
  const params = useLocalSearchParams<{ id?: string | string[]; animeLokId?: string | string[]; provider?: string | string[]; episodeNumber?: string | string[]; nextEpisodeNumber?: string | string[]; mode?: string | string[] }>();
  const id = first(params.id);
  const animeLokId = first(params.animeLokId);
  const isAnimeLok = first(params.provider) === 'animelok';
  const episodeNumber = first(params.episodeNumber);
  const nextEpisodeNumber = first(params.nextEpisodeNumber);
  const mode: Mode = first(params.mode) === 'dub' ? 'dub' : 'sub';
  const router = useRouter();
  const [qualityIndex, setQualityIndex] = useState(0);
  const [animeLokEmbedIndex, setAnimeLokEmbedIndex] = useState(0);
  const [animeLokPageLoading, setAnimeLokPageLoading] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [subtitleIndex, setSubtitleIndex] = useState<number | undefined>(undefined);
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [subtitleLoading, setSubtitleLoading] = useState(false);
  const [subtitleError, setSubtitleError] = useState<string | undefined>();
  const [loadedSubtitleKey, setLoadedSubtitleKey] = useState<string | undefined>();
  const loggedStreamKey = useRef<string | undefined>(undefined);
  const subtitleRequestId = useRef(0);

  const streamsQuery = useQuery({
    queryKey: ['streams', id, episodeNumber, mode],
    queryFn: () => anikoto.streams(id!, episodeNumber!, mode),
    enabled: !!id && !!episodeNumber && !isAnimeLok,
    retry: false,
  });
  const animeLokStreamsQuery = useQuery({
    queryKey: ['animelok-streams', animeLokId, episodeNumber],
    queryFn: () => animelok.scrapeStream(animeLokId!, episodeNumber!),
    enabled: isAnimeLok && !!animeLokId && !!episodeNumber,
    retry: false,
  });
  const animeLokEmbeds = animeLokStreamsQuery.data?.[mode].embeds ?? [];
  const animeLokEmbed = animeLokEmbeds[animeLokEmbedIndex];
  const sourceStreams = streamsQuery.data ?? [];
  const primaryStream = sourceStreams[0];
  const qualityDiscovery = useQuery({
    queryKey: ['stream-qualities', id, episodeNumber, mode, sourceStreams.map((item) => item.url)],
    queryFn: async () => {
      const expanded = await Promise.all(sourceStreams.map((item) =>
        item.hls ? anikoto.discoverQualities(item) : Promise.resolve([item]),
      ));
      return expanded.flat();
    },
    enabled: sourceStreams.some((item) => item.hls),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const discoveredVariants = qualityDiscovery.data ?? [];
  const qualityOptions = [...sourceStreams, ...discoveredVariants].filter((item, index, all) =>
    all.findIndex((candidate) => candidate.url === item.url) === index,
  );
  const stream = qualityOptions[Math.min(qualityIndex, Math.max(qualityOptions.length - 1, 0))];
  const player = useVideoPlayer(stream ? { uri: stream.url, headers: stream.headers } : null);

  useEffect(() => {
    player.timeUpdateEventInterval = 0.5;
    const subscription = player.addListener('timeUpdate', (event) => setCurrentTime(event.currentTime));
    return () => subscription.remove();
  }, [player]);

  useEffect(() => {
    setQualityIndex(0);
    setSubtitleIndex(undefined);
    setLoadedSubtitleKey(undefined);
  }, [episodeNumber, mode, streamsQuery.data]);
  useEffect(() => {
    setAnimeLokEmbedIndex(0);
    setAnimeLokPageLoading(true);
  }, [episodeNumber, mode, animeLokStreamsQuery.data]);
  useEffect(() => {
    const logKey = `${episodeNumber}:${mode}`;
    if (!streamsQuery.data || loggedStreamKey.current === logKey) return;
    console.log(JSON.stringify({
      episode: episodeNumber,
      mode,
      streams: streamsQuery.data.map((item) => ({ resolution: item.resolution, hls: item.hls, subtitles: item.subtitles })),
    }));
    loggedStreamKey.current = logKey;
  }, [episodeNumber, mode, streamsQuery.data]);
  const defaultSubtitleIndex = stream?.subtitles.findIndex((track) => track.default) ?? -1;
  const resolvedSubtitleIndex = subtitleIndex === undefined
    ? defaultSubtitleIndex >= 0 ? defaultSubtitleIndex : stream?.subtitles.length ? 0 : -1
    : subtitleIndex;
  const selectedSubtitle = resolvedSubtitleIndex >= 0 ? stream?.subtitles[resolvedSubtitleIndex] : undefined;
  const subtitleKey = `${id}:${episodeNumber}:${mode}:${selectedSubtitle?.url ?? 'off'}`;
  const subtitleReferer = stream?.headers.Referer;
  const subtitleOrigin = stream?.headers.Origin;
  const subtitleUserAgent = stream?.headers['User-Agent'];
  useEffect(() => {
    const requestId = subtitleRequestId.current + 1;
    subtitleRequestId.current = requestId;
    setSubtitleCues([]);
    setSubtitleError(undefined);
    if (!stream) {
      setSubtitleLoading(false);
      return;
    }
    if (!selectedSubtitle) {
      setSubtitleLoading(false);
      setLoadedSubtitleKey(subtitleKey);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setSubtitleLoading(true);
    setLoadedSubtitleKey(undefined);
    const subtitleHeaders: Record<string, string> = {
      ...stream.headers,
      Accept: 'text/vtt, text/plain, application/octet-stream, */*',
    };
    fetch(selectedSubtitle.url, { headers: subtitleHeaders, signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Subtitle HTTP ${response.status}`);
        return response.text().then((text) => ({
          text,
          status: response.status,
          contentType: response.headers.get('content-type'),
        }));
      })
      .then(({ text, status, contentType }) => {
        if (!active || subtitleRequestId.current !== requestId) return;
        const cues = parseWebVtt(text);
        console.log(JSON.stringify({
          subtitle: selectedSubtitle.label,
          status,
          contentType,
          textLength: text.length,
          cueCount: cues.length,
          firstCue: cues[0],
          bodyPreview: cues.length ? undefined : text.slice(0, 240),
          headers: { referer: subtitleHeaders['Referer'], origin: subtitleHeaders['Origin'], userAgent: !!subtitleHeaders['User-Agent'] },
        }));
        if (active) {
          setSubtitleCues(cues);
          if (!cues.length) setSubtitleError('The subtitle file loaded, but no WebVTT cues were parsed.');
          setSubtitleLoading(false);
          if (cues.length) setLoadedSubtitleKey(subtitleKey);
        }
      })
      .catch((error: unknown) => {
        if (!active || subtitleRequestId.current !== requestId) return;
        if (!(error instanceof Error && error.name === 'AbortError')) console.warn('Subtitle fetch or parsing failed:', error);
        setSubtitleError(error instanceof Error ? error.message : 'Could not load subtitles');
        setSubtitleLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [selectedSubtitle?.url, subtitleKey, subtitleReferer, subtitleOrigin, subtitleUserAgent, !!stream]);

  const subtitleReady = !selectedSubtitle || (loadedSubtitleKey === subtitleKey && subtitleCues.length > 0);
  const playbackReady = !!stream && subtitleReady && !subtitleLoading;
  useEffect(() => {
    if (playbackReady) player.play();
    else player.pause();
  }, [player, playbackReady, stream?.url]);

  const activeCue = subtitleCues.find((cue) => currentTime >= cue.start && currentTime < cue.end);

  if (!id || !episodeNumber) return <View style={styles.center}><Text style={styles.error}>This episode link is incomplete.</Text></View>;

  if (isAnimeLok) {
    const track = animeLokStreamsQuery.data?.[mode];
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: `Episode ${episodeNumber}`, headerBackTitle: 'Episodes' }} />
        {animeLokStreamsQuery.isPending ? <View style={styles.center}><ActivityIndicator size="large" color={colors.accent} /><Text style={styles.muted}>Finding AnimeLok players…</Text></View> : null}
        {animeLokStreamsQuery.isError ? <View style={styles.center}><Text style={styles.error}>{friendlyError(animeLokStreamsQuery.error)}</Text><Pressable onPress={() => void animeLokStreamsQuery.refetch()} style={styles.button}><Text style={styles.buttonText}>Retry</Text></Pressable></View> : null}
        {!animeLokStreamsQuery.isPending && !animeLokStreamsQuery.isError ? (
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.heading}>Episode {episodeNumber} · {mode.toUpperCase()} · AnimeLok</Text>
            <Text style={styles.muted}>Choose an AnimeLok server. Its player is shown here in the app.</Text>
            {track?.embeds.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.qualities}>
              {track.embeds.map((embed, index) => (
                <Pressable key={`${embed.url}-${index}`} onPress={() => { setAnimeLokEmbedIndex(index); setAnimeLokPageLoading(true); }} style={[styles.quality, index === animeLokEmbedIndex && styles.qualitySelected]}>
                  <Text style={[styles.qualityText, index === animeLokEmbedIndex && styles.qualityTextSelected]}>{embed.server || `Server ${index + 1}`}</Text>
                </Pressable>
              ))}
            </ScrollView> : null}
            {animeLokEmbed ? <View style={styles.webPlayer}>
              <WebView
                key={animeLokEmbed.url}
                source={{ uri: animeLokEmbed.url }}
                style={styles.webView}
                javaScriptEnabled
                domStorageEnabled
                allowsInlineMediaPlayback
                allowsFullscreenVideo
                mediaPlaybackRequiresUserAction={false}
                onLoadStart={() => setAnimeLokPageLoading(true)}
                onLoadEnd={() => setAnimeLokPageLoading(false)}
                onError={() => setAnimeLokPageLoading(false)}
                originWhitelist={['https://*']}
              />
              {animeLokPageLoading ? <View style={styles.webLoading}><ActivityIndicator size="large" color={colors.accent} /><Text style={styles.muted}>Loading embedded player…</Text></View> : null}
            </View> : null}
            {!track?.embeds.length ? <Text style={styles.error}>AnimeLok returned no {mode} players for this episode.</Text> : null}
            {track?.hash ? <Text style={styles.muted}>Video reference: {track.hash}</Text> : null}
            {nextEpisodeNumber ? <Pressable onPress={() => router.replace({ pathname: '/player', params: { id, animeLokId, provider: 'animelok', episodeNumber: nextEpisodeNumber, mode } })} style={styles.button}><Text style={styles.buttonText}>Next episode</Text></Pressable> : null}
          </ScrollView>
        ) : null}
      </View>
    );
  }

  const skipOutro = () => {
    if (nextEpisodeNumber) {
      router.replace({ pathname: '/player', params: { id, episodeNumber: nextEpisodeNumber, mode } });
    } else {
      player.currentTime = player.duration;
    }
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: `Episode ${episodeNumber}`, headerBackTitle: 'Episodes' }} />
      {streamsQuery.isPending ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.accent} /><Text style={styles.muted}>Finding a playable stream…</Text></View>
      ) : streamsQuery.isError ? (
        <View style={styles.center}><Text style={styles.error}>{friendlyError(streamsQuery.error)}</Text><Pressable onPress={() => void streamsQuery.refetch()} style={styles.button}><Text style={styles.buttonText}>Retry</Text></Pressable></View>
      ) : stream ? (
        <ScrollView contentContainerStyle={styles.content}>
          <VideoView player={player} style={styles.video} nativeControls contentFit="contain" buttonOptions={{ showSubtitles: true }} fullscreenOptions={{ enable: true }} />
          <View style={styles.captionArea}>
            {activeCue ? <Text style={styles.caption}>{activeCue.text}</Text> : subtitleLoading ? <Text style={styles.captionHint}>Loading selected subtitles…</Text> : subtitleError ? <Text style={styles.captionHint}>{subtitleError}</Text> : selectedSubtitle && subtitleCues.length === 0 ? <Text style={styles.captionHint}>No subtitle cue at {currentTime.toFixed(1)}s</Text> : null}
          </View>
          <Text style={styles.heading}>Episode {episodeNumber} · {mode.toUpperCase()}</Text>
          {qualityDiscovery.isFetching ? <Text style={styles.muted}>Checking available qualities in the background…</Text> : null}
          {qualityDiscovery.isError ? <View style={styles.qualityError}><Text style={styles.muted}>Could not check for more qualities.</Text><Pressable onPress={() => void qualityDiscovery.refetch()}><Text style={styles.qualityRetry}>Retry scan</Text></Pressable></View> : null}
          {qualityOptions.length > 1 ? <>
            <Text style={styles.muted}>Stream quality</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.qualities}>
              {qualityOptions.map((option: Stream, index: number) => (
                <Pressable key={`${option.url}-${index}`} onPress={() => setQualityIndex(index)} style={[styles.quality, index === qualityIndex && styles.qualitySelected]}>
                  <Text style={[styles.qualityText, index === qualityIndex && styles.qualityTextSelected]}>{option.url === primaryStream?.url && option.hls && discoveredVariants.some((candidate) => candidate.url !== option.url) ? 'Auto' : option.resolution || 'Auto'}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </> : !qualityDiscovery.isFetching ? <Text style={styles.muted}>The provider returned one stream: {stream.resolution || 'Auto'}.</Text> : null}
          {stream.subtitles.length > 0 ? <>
            <Text style={styles.muted}>Subtitles</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.qualities}>
              <Pressable onPress={() => setSubtitleIndex(-1)} style={[styles.quality, resolvedSubtitleIndex < 0 && styles.qualitySelected]}><Text style={[styles.qualityText, resolvedSubtitleIndex < 0 && styles.qualityTextSelected]}>Off</Text></Pressable>
              {stream.subtitles.map((track: Subtitle, index: number) => (
                <Pressable key={`${track.url}-${index}`} onPress={() => setSubtitleIndex(index)} style={[styles.quality, resolvedSubtitleIndex === index && styles.qualitySelected]}>
                  <Text style={[styles.qualityText, resolvedSubtitleIndex === index && styles.qualityTextSelected]}>{track.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
            {subtitleLoading ? <Text style={styles.muted}>Loading subtitles…</Text> : null}
            {subtitleError ? <View style={styles.subtitleErrorRow}><Text style={styles.subtitleError}>Could not load selected subtitles: {subtitleError}</Text><Pressable onPress={() => setSubtitleIndex(-1)}><Text style={styles.qualityRetry}>Play without</Text></Pressable></View> : null}
          </> : <Text style={styles.muted}>No external subtitles were returned for this stream. Embedded tracks, if present, are available from the video controls.</Text>}
          <View style={styles.actions}>
            {stream.intro && currentTime >= stream.intro.start && currentTime <= stream.intro.end ? <Pressable onPress={() => { player.currentTime = stream.intro!.end; }} style={styles.button}><Text style={styles.buttonText}>Skip intro</Text></Pressable> : null}
            {stream.outro && currentTime >= stream.outro.start && currentTime <= stream.outro.end ? <Pressable onPress={skipOutro} style={styles.button}><Text style={styles.buttonText}>{nextEpisodeNumber ? 'Next episode' : 'Skip outro'}</Text></Pressable> : null}
          </View>
          {/* TODO: expo-video has no sidecar VTT source field; the custom overlay renders the selected VTT cues. */}
        </ScrollView>
      ) : <View style={styles.center}><Text style={styles.error}>No streams were returned for this episode.</Text><Pressable onPress={() => void streamsQuery.refetch()} style={styles.button}><Text style={styles.buttonText}>Retry</Text></Pressable></View>}
    </View>
  );
}

type SubtitleCue = { start: number; end: number; text: string };

function parseWebVtt(value: string): SubtitleCue[] {
  const lines = value.split('\n').map((line) => line.trim());
  const cues: SubtitleCue[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].includes('-->')) continue;
    const times = lines[index].split('-->');
    if (times.length < 2) continue;
    const start = parseVttTime(times[0]);
    const end = parseVttTime(times[1].trim().split(' ')[0]);
    if (start === undefined || end === undefined || end <= start) continue;
    const textLines: string[] = [];
    for (let next = index + 1; next < lines.length && lines[next] !== ''; next++) textLines.push(stripVttTags(lines[next]));
    if (textLines.length) cues.push({ start, end, text: textLines.join('\n') });
  }
  return cues;
}

function parseVttTime(value: string): number | undefined {
  const normalized = value.trim().split(',').join('.');
  const parts = normalized.split(':');
  if (parts.length < 2 || parts.length > 3) return undefined;
  const last = parts[parts.length - 1].split('.');
  const seconds = Number(last[0]);
  const fraction = last[1] ? Number(`0.${last[1]}`) : 0;
  const minutes = Number(parts[parts.length - 2]);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![seconds, fraction, minutes, hours].every(Number.isFinite)) return undefined;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

function stripVttTags(value: string): string {
  let output = '';
  let insideTag = false;
  for (const character of value) {
    if (character === '<') insideTag = true;
    else if (character === '>') insideTag = false;
    else if (!insideTag) output += character;
  }
  return output;
}

function first(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingBottom: 32 },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  webPlayer: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', overflow: 'hidden', borderRadius: 12, marginTop: 14 },
  webView: { flex: 1, backgroundColor: '#000' },
  webLoading: { ...StyleSheet.absoluteFill, justifyContent: 'center', alignItems: 'center', gap: 10, backgroundColor: colors.panel },
  captionArea: { minHeight: 48, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.panel, marginHorizontal: 16, marginTop: 8, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  caption: { color: colors.text, textAlign: 'center', fontSize: 16, lineHeight: 23, fontWeight: '600' },
  captionHint: { color: colors.muted, textAlign: 'center', fontSize: 12, lineHeight: 18 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 14, backgroundColor: colors.bg },
  heading: { color: colors.text, fontSize: 20, fontWeight: '800', paddingHorizontal: 20, marginTop: 22 },
  muted: { color: colors.muted, fontSize: 13, paddingHorizontal: 20, marginTop: 8 },
  qualities: { gap: 9, paddingHorizontal: 20, paddingVertical: 16 },
  quality: { borderWidth: 1, borderColor: '#393944', paddingHorizontal: 15, paddingVertical: 9, borderRadius: 10 },
  qualitySelected: { borderColor: colors.accent, backgroundColor: colors.accent },
  qualityText: { color: colors.text, fontWeight: '700' },
  qualityTextSelected: { color: colors.bg },
  qualityError: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, marginTop: 8 },
  qualityRetry: { color: colors.accent, fontWeight: '700' },
  embedChoice: { marginHorizontal: 20, marginTop: 12, padding: 16, borderWidth: 1, borderColor: '#393944', borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  embedName: { color: colors.text, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingVertical: 10 },
  button: { alignSelf: 'flex-start', backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  buttonText: { color: colors.bg, fontWeight: '800' },
  error: { color: '#ffb4ab', textAlign: 'center' },
  subtitleError: { color: '#ffb4ab', fontSize: 12, lineHeight: 18, paddingHorizontal: 20, paddingTop: 6 },
  subtitleErrorRow: { paddingHorizontal: 20 },
});
