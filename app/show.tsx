import { useRef, useState } from 'react';
import { Link, Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { anikoto, animelok } from '../src/services/client';
import { friendlyError } from '../src/services/errors';
import type { Episode, Mode } from '../src/services/anikoto';

const colors = { bg: '#101116', panel: '#1b1c24', text: '#f4f3f8', muted: '#a4a4b1', accent: '#b6a1ff' };

export default function ShowScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const [mode, setMode] = useState<Mode>('sub');
  const [episodeProvider, setEpisodeProvider] = useState<'anikoto' | 'animelok'>('anikoto');
  const logged = useRef(false);
  const details = useQuery({ queryKey: ['details', id], queryFn: () => anikoto.details(id!), enabled: !!id });
  const anikotoEpisodes = useQuery({ queryKey: ['episodes', id], queryFn: () => anikoto.episodeList(id!), enabled: !!id && episodeProvider === 'anikoto' });
  const animelokEpisodes = useQuery({
    queryKey: ['animelok-episodes', details.data?.anilistId],
    queryFn: async () => {
      const show = await animelok.scrapeEpisodes(details.data!.anilistId);
      if (!show) throw new Error('AnimeLok has no episode list for this show.');
      return show.episodes.map((episode) => ({
        number: String(episode.number),
        title: episode.title ?? undefined,
        thumbnail: episode.thumbnail,
        aired: episode.airdate ?? undefined,
        raw: episode,
      } satisfies Episode));
    },
    enabled: episodeProvider === 'animelok' && !!details.data?.anilistId,
  });

  if (!id) return <View style={styles.center}><Text style={styles.error}>This show link is missing its ID.</Text></View>;
  const selectedEpisodesQuery = episodeProvider === 'animelok' ? animelokEpisodes : anikotoEpisodes;
  if (details.isPending || selectedEpisodesQuery.isPending) return <View style={styles.center}><ActivityIndicator size="large" color={colors.accent} /><Text style={styles.muted}>Loading show details…</Text></View>;
  if (details.isError || selectedEpisodesQuery.isError) {
    const error = details.error ?? selectedEpisodesQuery.error;
    return <View style={styles.center}><Text style={styles.error}>{friendlyError(error)}</Text><Pressable onPress={() => { void details.refetch(); void selectedEpisodesQuery.refetch(); }} style={styles.button}><Text style={styles.buttonText}>Retry</Text></Pressable></View>;
  }

  const show = details.data;
  const list = selectedEpisodesQuery.data ?? [];
  if (!logged.current && list.length > 0 && list[0]?.raw !== undefined) {
    console.log(JSON.stringify(list[0]?.raw));
    logged.current = true;
  }
  const title = show.title.english ?? show.title.romaji ?? show.title.native ?? 'Anime details';

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title, headerBackTitle: 'Search' }} />
      <ScrollView contentContainerStyle={styles.content}>
        {show.banner ? <Image source={{ uri: show.banner }} style={styles.banner} /> : <View style={styles.bannerFallback} />}
        <View style={styles.hero}>
          {show.cover ? <Image source={{ uri: show.cover }} style={styles.cover} /> : null}
          <View style={styles.heroCopy}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.muted}>{[show.year, show.format, show.status].filter(Boolean).join(' · ')}</Text>
            {show.score !== undefined ? <Text style={styles.score}>★ {show.score}/100</Text> : null}
          </View>
        </View>
        {show.description ? <Text style={styles.description}>{show.description.replaceAll('<br>', '\n').replaceAll('<br />', '\n')}</Text> : null}
        {show.genres.length > 0 ? <Text style={styles.meta}><Text style={styles.label}>Genres  </Text>{show.genres.join(' · ')}</Text> : null}
        {show.studios.length > 0 ? <Text style={styles.meta}><Text style={styles.label}>Studios  </Text>{show.studios.join(' · ')}</Text> : null}
        <View style={styles.sourceRow}>
          <Text style={styles.label}>Episode source</Text>
          <View style={styles.toggle}>
            {(['anikoto', 'animelok'] as const).map((choice) => <Pressable key={choice} onPress={() => setEpisodeProvider(choice)} style={[styles.toggleItem, episodeProvider === choice && styles.toggleSelected]}><Text style={[styles.toggleText, episodeProvider === choice && styles.toggleTextSelected]}>{choice === 'anikoto' ? 'Anikoto' : 'AnimeLok'}</Text></Pressable>)}
          </View>
        </View>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Episodes <Text style={styles.muted}>({list.length})</Text></Text>
          <View style={styles.toggle}>
            {(['sub', 'dub'] as const).map((choice) => <Pressable key={choice} onPress={() => setMode(choice)} style={[styles.toggleItem, mode === choice && styles.toggleSelected]}><Text style={[styles.toggleText, mode === choice && styles.toggleTextSelected]}>{choice.toUpperCase()}</Text></Pressable>)}
          </View>
        </View>
        {list.map((episode: Episode, index: number) => (
          <Link key={episode.number} href={{ pathname: '/player', params: { id, episodeNumber: episode.number, nextEpisodeNumber: list[index + 1]?.number, mode, provider: episodeProvider, animeLokId: episodeProvider === 'animelok' ? show.anilistId : undefined } }} asChild>
            <Pressable style={styles.episode}>
              {episode.thumbnail ? <Image source={{ uri: episode.thumbnail }} style={styles.episodeImage} /> : <View style={[styles.episodeImage, styles.episodePlaceholder]}><Text style={styles.play}>▶</Text></View>}
              <View style={styles.episodeCopy}>
                <Text style={styles.episodeNumber}>EPISODE {episode.number}</Text>
                {episode.title ? <Text style={styles.episodeTitle} numberOfLines={2}>{episode.title}</Text> : null}
                {episode.aired ? <Text style={styles.muted}>{episode.aired}</Text> : null}
              </View>
              <Text style={styles.play}>▶</Text>
            </Pressable>
          </Link>
        ))}
        {list.length === 0 ? <Text style={styles.muted}>No episodes are listed for this title yet.</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingBottom: 32 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 14, backgroundColor: colors.bg },
  banner: { width: '100%', height: 185, opacity: 0.82 },
  bannerFallback: { height: 110, backgroundColor: colors.panel },
  hero: { flexDirection: 'row', gap: 16, paddingHorizontal: 20, marginTop: -44, alignItems: 'flex-end' },
  cover: { width: 104, height: 148, borderRadius: 12, backgroundColor: colors.panel },
  heroCopy: { flex: 1, paddingBottom: 8 },
  title: { color: colors.text, fontSize: 23, fontWeight: '800', marginBottom: 8 },
  score: { color: '#ffd479', marginTop: 7, fontWeight: '700' },
  description: { color: '#d2d0da', fontSize: 14, lineHeight: 21, paddingHorizontal: 20, marginTop: 20 },
  meta: { color: colors.muted, paddingHorizontal: 20, marginTop: 13, lineHeight: 20 },
  label: { color: colors.text, fontWeight: '700' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, marginTop: 28, marginBottom: 10 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, marginTop: 20 },
  sectionTitle: { color: colors.text, fontSize: 19, fontWeight: '800' },
  muted: { color: colors.muted, fontSize: 13 },
  toggle: { flexDirection: 'row', padding: 3, borderRadius: 10, backgroundColor: colors.panel },
  toggleItem: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  toggleSelected: { backgroundColor: colors.accent },
  toggleText: { color: colors.muted, fontWeight: '700', fontSize: 12 },
  toggleTextSelected: { color: colors.bg },
  episode: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 9, gap: 12 },
  episodeImage: { width: 96, height: 60, borderRadius: 9, backgroundColor: colors.panel },
  episodePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  episodeCopy: { flex: 1, gap: 4 },
  episodeNumber: { color: colors.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  episodeTitle: { color: colors.text, fontWeight: '600' },
  play: { color: colors.accent, fontWeight: '800' },
  error: { color: '#ffb4ab', textAlign: 'center' },
  button: { backgroundColor: colors.accent, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  buttonText: { color: colors.bg, fontWeight: '800' },
});
