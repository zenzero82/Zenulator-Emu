import { Alert, Platform } from 'react-native';

/** RN Web's Alert.alert is a no-op; the explicit Reset button is confirmation there. */
export function confirmControlReset(title: string, message: string, reset: () => void): void {
  if (Platform.OS === 'web') {
    reset();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Reset', style: 'destructive', onPress: reset },
  ]);
}
