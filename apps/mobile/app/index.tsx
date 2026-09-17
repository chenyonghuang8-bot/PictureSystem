import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
import { tokens } from "@family-album/ui-tokens";

export default function HomeScreen() {
  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>FAMILY ALBUM</Text>
        <Text style={styles.title}>张家的时光</Text>
        <Text style={styles.copy}>Android 优先的移动端骨架已经就绪。</Text>
        <View style={styles.status}>
          <View style={styles.dot} />
          <Text style={styles.statusText}>Phase 0 foundation ready</Text>
        </View>
      </View>
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    justifyContent: "center",
    padding: tokens.space[6],
    backgroundColor: tokens.color.background,
  },
  card: {
    padding: tokens.space[7],
    borderRadius: tokens.radius.xl,
    backgroundColor: tokens.color.surface,
    shadowColor: "#312C24",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08,
    shadowRadius: 28,
    elevation: 3,
  },
  eyebrow: {
    color: tokens.color.accent,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.4,
  },
  title: {
    marginTop: tokens.space[3],
    color: tokens.color.text,
    fontSize: 36,
    fontWeight: "700",
  },
  copy: {
    marginTop: tokens.space[2],
    color: tokens.color.textMuted,
    fontSize: 16,
    lineHeight: 26,
  },
  status: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[2],
    marginTop: tokens.space[6],
    paddingHorizontal: tokens.space[3],
    paddingVertical: tokens.space[2],
    borderRadius: tokens.radius.pill,
    backgroundColor: tokens.color.accentSoft,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: tokens.color.accent,
  },
  statusText: {
    color: tokens.color.accentStrong,
    fontSize: 14,
    fontWeight: "600",
  },
});
