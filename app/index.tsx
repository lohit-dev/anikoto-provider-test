import { useEffect, useState } from 'react';
import { Link, Stack } from 'expo-router';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { anikoto } from '../src/services/client';
import { friendlyError } from '../src/services/errors';
import type { SearchResult } from '../src/services/anikoto';

const colors = { bg: '#101116', panel: '#1b1c24', text: '#f4f3f8', muted: '#a4a4b1', accent: '#b6a1ff' };

export default function SearchScreen() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => anikoto.search(debounced),
    enabled: debounced.length > 1,
  });

  const renderResult = ({ item }: { item: SearchResult }) => (
    <Link href={{ pathname: '/show', params: { id: item.id } }} asChild>
      <Pressable style={styles.card}>
        {item.cover ? <Image source={{ uri: item.cover }} style={styles.cover} /> : <View style={[styles.cover, styles.placeholder]}><Text style={styles.placeholderText}>ANIME</Text></View>}
        <Text style={styles.title} numberOfLines={2}>{item.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>{[item.year, item.format, item.score !== undefined ? `★ ${item.score}` : undefined].filter(Boolean).join(' · ')}</Text>
      </Pressable>
    </Link>
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'AniKoto', headerLargeTitle: false }} />
      <Text style={styles.eyebrow}>DISCOVER</Text>
      <Text style={styles.heading}>Find your next anime.</Text>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search anime titles"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        returnKeyType="search"
        style={styles.input}
      />
      {query.trim().length > 1 && search.isPending ? <ActivityIndicator color={colors.accent} style={styles.center} /> : null}
      {search.isError ? <View style={styles.message}><Text style={styles.error}>{friendlyError(search.error)}</Text><Pressable onPress={() => void search.refetch()} style={styles.retry}><Text style={styles.retryText}>Retry</Text></Pressable></View> : null}
      {!search.isPending && !search.isError && debounced.length > 1 && search.data?.length === 0 ? <Text style={styles.messageText}>No titles found. Try another search.</Text> : null}
      {debounced.length <= 1 ? <Text style={styles.messageText}>Search by title to explore the catalog.</Text> : null}
      <FlatList
        data={search.data ?? []}
        renderItem={renderResult}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20, paddingTop: 24 },
  eyebrow: { color: colors.accent, fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  heading: { color: colors.text, fontSize: 28, fontWeight: '800', marginTop: 8, marginBottom: 18 },
  input: { height: 52, borderRadius: 15, backgroundColor: colors.panel, color: colors.text, paddingHorizontal: 16, fontSize: 16, marginBottom: 20 },
  list: { paddingBottom: 30 },
  row: { justifyContent: 'space-between', gap: 14 },
  card: { width: '48%', marginBottom: 20 },
  cover: { width: '100%', aspectRatio: 0.72, borderRadius: 14, backgroundColor: colors.panel },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: colors.muted, fontWeight: '800', letterSpacing: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 9 },
  meta: { color: colors.muted, fontSize: 12, marginTop: 5 },
  center: { marginVertical: 20 },
  message: { paddingVertical: 12 },
  messageText: { color: colors.muted, marginBottom: 14 },
  error: { color: '#ffb4ab', marginBottom: 10 },
  retry: { alignSelf: 'flex-start', borderRadius: 10, backgroundColor: colors.accent, paddingHorizontal: 16, paddingVertical: 9 },
  retryText: { color: colors.bg, fontWeight: '800' },
});
