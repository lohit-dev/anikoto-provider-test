import '../global.css';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';

import { Stack } from 'expo-router';
import { queryClient } from '../src/services/query';

export default function Layout() {
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <Stack screenOptions={{ headerStyle: { backgroundColor: '#101116' }, headerTintColor: '#f4f3f8', contentStyle: { backgroundColor: '#101116' } }} />
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
