/**
 * Mobile app project template (D6).
 *
 * `mobile_app` projects are Expo (React Native) + TypeScript applications that talk to the same
 * Project API and Project Auth as the website of the same DataBackend. They do not get a copy of
 * the database: the project is attached to the existing DataBackend, so collections, end users,
 * access policies and RLS are shared with the site.
 *
 * The template is generated into the Project workspace by the orchestrator; the sandbox then runs
 * `expo start --web` for Live Preview. Store builds are out of scope (see BuildProvider).
 */

export const MOBILE_APP_FRAMEWORK = "expo";
/** Static Expo Web export is served on this port so the existing preview proxy path is reused. */
export const MOBILE_APP_PREVIEW_PORT = 3000;
/** Collections the generated app reads by default until the agent adjusts the schema module. */
export const MOBILE_APP_DEFAULT_COLLECTION = "products";

export interface MobileAppTemplateOptions {
  name: string;
  slug: string;
  scheme: string;
  /** Bundle/package identifier base, for example `com.npati.shop`. */
  bundleIdentifier?: string;
}

export interface MobileAppScaffold {
  framework: typeof MOBILE_APP_FRAMEWORK;
  devCommand: string;
  port: number;
  files: Record<string, string>;
}

export function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "mobile-app";
}

/** Deep link scheme for the app, derived from the project name and validated per project. */
export function defaultAppScheme(name: string): string {
  const slug = slugifyProjectName(name);
  return `npati-${slug}`.slice(0, 40);
}

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{1,39}$/;
const RESERVED_SCHEMES = new Set(["http", "https", "file", "data", "javascript", "about", "blob", "ws", "wss", "mailto", "tel"]);

export function isValidAppScheme(scheme: string): boolean {
  return typeof scheme === "string" && SCHEME_PATTERN.test(scheme) && !RESERVED_SCHEMES.has(scheme);
}

/**
 * Normalizes a redirect target: absolute URL without credentials or fragment.
 * Query strings are rejected because the gateway appends its own one-time token.
 */
export function normalizeAuthRedirectUrl(input: string): string | null {
  if (typeof input !== "string" || !input.trim() || input.length > 512) return null;
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) return null;
  if (!isValidAppScheme(parsed.protocol.replace(/:$/, "")) && parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString().replace(/\/$/, "") === "" ? null : parsed.toString();
}

/** Redirect targets must be registered for the Project before the gateway will use them. */
export function isAuthRedirectAllowed(redirectTo: string, allowedRedirects: readonly string[]): boolean {
  const normalized = normalizeAuthRedirectUrl(redirectTo);
  if (!normalized) return false;
  return allowedRedirects.some((allowed) => normalizeAuthRedirectUrl(allowed) === normalized);
}

function scalarFieldType(type: string): "string" | "text" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "json" | "uuid" | "enum" {
  const known = ["string", "text", "integer", "decimal", "boolean", "date", "datetime", "json", "uuid", "enum"];
  return (known.includes(type) ? type : "string") as ReturnType<typeof scalarFieldType>;
}

export function createMobileAppScaffold(options: MobileAppTemplateOptions): MobileAppScaffold {
  const slug = slugifyProjectName(options.slug || options.name);
  const scheme = isValidAppScheme(options.scheme) ? options.scheme : defaultAppScheme(options.name);
  const bundleIdentifier = options.bundleIdentifier || `com.npati.${slug.replace(/-/g, "")}`;
  const collection = MOBILE_APP_DEFAULT_COLLECTION;

  const packageJson = JSON.stringify(
    {
      name: slug,
      version: "1.0.0",
      private: true,
      main: "expo/AppEntry.js",
      scripts: {
        start: "expo start",
        web: "expo start --web",
        export: "expo export --platform web --output-dir dist",
        android: "expo start --android",
        ios: "expo start --ios",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        expo: "~51.0.39",
        "@expo/metro-runtime": "~3.2.3",
        "expo-constants": "~16.0.2",
        "expo-linking": "~6.3.1",
        "expo-secure-store": "~13.0.2",
        "expo-status-bar": "~1.12.1",
        react: "18.2.0",
        "react-dom": "18.2.0",
        "react-native": "0.74.5",
        "react-native-web": "~0.19.10",
      },
      devDependencies: {
        "@types/react": "~18.2.79",
        typescript: "~5.3.3",
      },
    },
    null,
    2,
  );

  // app.config.js surfaces the sandbox-provided Project API variables inside the JS bundle.
  // Only the publishable key is ever read here: the secret key is server-side only.
  const appConfig = [
    "const projectApiUrl = process.env.PROJECT_API_URL || process.env.EXPO_PUBLIC_PROJECT_API_URL || \"\";",
    "const publishableKey = process.env.PROJECT_PUBLISHABLE_KEY || process.env.EXPO_PUBLIC_PROJECT_PUBLISHABLE_KEY || \"\";",
    "",
    "module.exports = {",
    "  expo: {",
    `    name: ${JSON.stringify(options.name)},`,
    `    slug: ${JSON.stringify(slug)},`,
    `    scheme: ${JSON.stringify(scheme)},`,
    '    version: "1.0.0",',
    '    orientation: "portrait",',
    '    userInterfaceStyle: "automatic",',
    '    web: { bundler: "metro" },',
    `    ios: { supportsTablet: true, bundleIdentifier: ${JSON.stringify(bundleIdentifier)} },`,
    `    android: { package: ${JSON.stringify(bundleIdentifier)} },`,
    "    extra: { projectApiUrl, publishableKey },",
    "  },",
    "};",
    "",
  ].join("\n");

  const tsconfig = JSON.stringify(
    {
      extends: "expo/tsconfig.base",
      compilerOptions: { strict: true, jsx: "react-jsx", moduleResolution: "bundler" },
      include: ["**/*.ts", "**/*.tsx"],
    },
    null,
    2,
  );

  const configTs = [
    'import Constants from "expo-constants";',
    "",
    "type Extra = { projectApiUrl?: string; publishableKey?: string };",
    "",
    "const extra = (Constants.expoConfig?.extra ?? {}) as Extra;",
    "",
    "export const projectApiUrl = extra.projectApiUrl || process.env.EXPO_PUBLIC_PROJECT_API_URL || \"\";",
    "export const projectPublishableKey = extra.publishableKey || process.env.EXPO_PUBLIC_PROJECT_PUBLISHABLE_KEY || \"\";",
    `export const appScheme = ${JSON.stringify(scheme)};`,
    `export const defaultCollection = ${JSON.stringify(collection)};`,
    "/** Deep link the app opens after email verification or password reset. */",
    "export const authRedirectUrl = appScheme + \"://auth/callback\";",
    "",
  ].join("\n");

  const apiTs = [
    'import * as SecureStore from "expo-secure-store";',
    'import { createProjectClient, createSecureStoreStorage, parseAuthDeepLink } from "./npati-client";',
    'import { projectApiUrl, projectPublishableKey } from "./config";',
    "",
    "if (!projectApiUrl || !projectPublishableKey) {",
    '  console.warn("PROJECT_API_URL / PROJECT_PUBLISHABLE_KEY are not configured; the app cannot reach the Project API yet.");',
    "}",
    "",
    "/**",
    " * Refresh tokens are kept in the platform secure store (Keychain / Keystore), never in plain",
    " * AsyncStorage. The publishable key is public by design; the secret key must never be bundled.",
    " */",
    "export const client = createProjectClient({",
    "  apiUrl: projectApiUrl,",
    "  publishableKey: projectPublishableKey,",
    "  storage: createSecureStoreStorage(SecureStore),",
    "});",
    "",
    "/** Handles deep links such as npati-shop://auth/callback?kind=verify_email&token=... */",
    "export async function handleAuthDeepLink(url: string) {",
    "  const link = parseAuthDeepLink(url);",
    "  if (!link) return { handled: false as const };",
    '  if (link.kind === "verify_email") {',
    "    await client.auth.verifyEmail(link.token);",
    '    return { handled: true as const, kind: link.kind };',
    "  }",
    "  return { handled: true as const, kind: link.kind, token: link.token };",
    "}",
    "",
  ].join("\n");

  const validationTs = [
    "export type FieldType = \"string\" | \"text\" | \"integer\" | \"decimal\" | \"boolean\" | \"date\" | \"datetime\" | \"json\" | \"uuid\" | \"enum\";",
    "",
    "export interface FieldDefinition {",
    "  name: string;",
    "  type: FieldType;",
    "  required?: boolean;",
    "  options?: string[];",
    "}",
    "",
    "/** Client-side validation mirroring the Data Studio field types; the server stays authoritative. */",
    "export function validateRow(fields: FieldDefinition[], values: Record<string, unknown>): Record<string, string> {",
    "  const errors: Record<string, string> = {};",
    "  for (const field of fields) {",
    "    const value = values[field.name];",
    "    const empty = value === undefined || value === null || value === \"\";",
    "    if (empty) {",
    "      if (field.required) errors[field.name] = \"Required\";",
    "      continue;",
    "    }",
    "    switch (field.type) {",
    "      case \"integer\":",
    "        if (!Number.isInteger(Number(value))) errors[field.name] = \"Must be a whole number\";",
    "        break;",
    "      case \"decimal\":",
    "        if (Number.isNaN(Number(value))) errors[field.name] = \"Must be a number\";",
    "        break;",
    "      case \"boolean\":",
    "        if (typeof value !== \"boolean\") errors[field.name] = \"Must be true or false\";",
    "        break;",
    "      case \"date\":",
    "        if (Number.isNaN(Date.parse(String(value)))) errors[field.name] = \"Must be a date (YYYY-MM-DD)\";",
    "        break;",
    "      case \"datetime\":",
    "        if (Number.isNaN(Date.parse(String(value)))) errors[field.name] = \"Must be a date and time\";",
    "        break;",
    "      case \"uuid\":",
    "        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value))) errors[field.name] = \"Must be a UUID\";",
    "        break;",
    "      case \"json\":",
    "        if (typeof value === \"string\") { try { JSON.parse(value); } catch { errors[field.name] = \"Must be valid JSON\"; } }",
    "        break;",
    "      case \"enum\":",
    "        if (field.options && field.options.length && !field.options.includes(String(value))) errors[field.name] = \"Must be one of: \" + field.options.join(\", \");",
    "        break;",
    "      default:",
    "        break;",
    "    }",
    "  }",
    "  return errors;",
    "}",
    "",
  ].join("\n");

  const schemaTs = [
    "import type { FieldDefinition } from \"./validation\";",
    "",
    "/**",
    " * Field definitions for the collection the app lists. Keep this in sync with the Data Studio",
    " * schema (Project API /types.ts is generated from the live schema and is the source of truth).",
    " */",
    "export const collectionFields: FieldDefinition[] = [",
    "  { name: \"name\", type: \"string\", required: true },",
    "  { name: \"price\", type: \"decimal\", required: true },",
    "  { name: \"description\", type: \"text\" },",
    "];",
    "",
    "export const detailFieldNames = [\"name\", \"price\", \"description\"];",
    "",
  ].join("\n");

  const authScreen = [
    'import React, { useState } from "react";',
    'import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";',
    'import { client } from "../api";',
    "",
    "export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {",
    '  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");',
    '  const [email, setEmail] = useState("");',
    '  const [password, setPassword] = useState("");',
    '  const [error, setError] = useState("");',
    "  const [busy, setBusy] = useState(false);",
    "",
    "  async function submit() {",
    "    setBusy(true);",
    '    setError("");',
    "    try {",
    '      if (mode === "signIn") await client.auth.signIn({ email, password });',
    "      else await client.auth.signUp({ email, password });",
    "      onSignedIn();",
    "    } catch (cause) {",
    '      setError(cause instanceof Error ? cause.message : "Authentication failed");',
    "    } finally {",
    "      setBusy(false);",
    "    }",
    "  }",
    "",
    "  return (",
    '    <View style={styles.container}>',
    '      <Text style={styles.title}>{mode === "signIn" ? "Sign in" : "Create account"}</Text>',
    '      <TextInput style={styles.input} placeholder="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />',
    '      <TextInput style={styles.input} placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />',
    "      {error ? <Text style={styles.error}>{error}</Text> : null}",
    '      <Pressable style={styles.button} onPress={() => void submit()} disabled={busy}>',
    "        {busy ? <ActivityIndicator color=\"#fff\" /> : <Text style={styles.buttonText}>{mode === \"signIn\" ? \"Sign in\" : \"Sign up\"}</Text>}",
    "      </Pressable>",
    '      <Pressable onPress={() => setMode(mode === "signIn" ? "signUp" : "signIn")}>',
    '        <Text style={styles.link}>{mode === "signIn" ? "No account yet? Sign up" : "Already registered? Sign in"}</Text>',
    "      </Pressable>",
    '      <Pressable onPress={() => void client.auth.forgotPassword(email).catch(() => undefined)}>',
    '        <Text style={styles.link}>Forgot password? (opens the app through a deep link)</Text>',
    "      </Pressable>",
    "    </View>",
    "  );",
    "}",
    "",
    "const styles = StyleSheet.create({",
    '  container: { flex: 1, justifyContent: "center", padding: 24, gap: 12, backgroundColor: "#0f172a" },',
    '  title: { color: "#f8fafc", fontSize: 24, fontWeight: "600", marginBottom: 8 },',
    '  input: { backgroundColor: "#1e293b", color: "#f8fafc", padding: 12, borderRadius: 8 },',
    '  button: { backgroundColor: "#2563eb", padding: 14, borderRadius: 8, alignItems: "center" },',
    '  buttonText: { color: "#fff", fontWeight: "600" },',
    '  link: { color: "#93c5fd", textAlign: "center", paddingVertical: 6 },',
    '  error: { color: "#fca5a5" },',
    "});",
    "",
  ].join("\n");

  const listScreen = [
    'import React, { useCallback, useEffect, useState } from "react";',
    'import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";',
    'import { client } from "../api";',
    'import { defaultCollection } from "../config";',
    "",
    "export interface ListRow { id: string; [key: string]: unknown }",
    "",
    "export function ListScreen({ onOpen, onCreate, onSignOut }: { onOpen: (row: ListRow) => void; onCreate: () => void; onSignOut: () => void }) {",
    "  const [rows, setRows] = useState<ListRow[]>([]);",
    '  const [error, setError] = useState("");',
    "  const [refreshing, setRefreshing] = useState(false);",
    "",
    "  const load = useCallback(async () => {",
    "    setRefreshing(true);",
    "    try {",
    "      const result = await client.from<ListRow>(defaultCollection).list({ limit: 20, sort: \"id:desc\" });",
    "      setRows(result.data);",
    '      setError("");',
    "    } catch (cause) {",
    '      setError(cause instanceof Error ? cause.message : "Could not load data");',
    "    } finally {",
    "      setRefreshing(false);",
    "    }",
    "  }, []);",
    "",
    "  useEffect(() => { void load(); }, [load]);",
    "",
    "  return (",
    '    <View style={styles.container}>',
    '      <View style={styles.header}>',
    '        <Text style={styles.title}>{defaultCollection}</Text>',
    '        <Pressable onPress={onCreate}><Text style={styles.action}>New</Text></Pressable>',
    '        <Pressable onPress={onSignOut}><Text style={styles.action}>Sign out</Text></Pressable>',
    "      </View>",
    "      {error ? <Text style={styles.error}>{error}</Text> : null}",
    "      <FlatList",
    "        data={rows}",
    "        keyExtractor={(row) => row.id}",
    "        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} />}",
    "        ListEmptyComponent={<Text style={styles.muted}>No rows yet.</Text>}",
    "        renderItem={({ item }) => (",
    '          <Pressable style={styles.row} onPress={() => onOpen(item)}>',
    '            <Text style={styles.rowTitle}>{String(item.name ?? item.title ?? item.id)}</Text>',
    '            <Text style={styles.muted}>{String(item.price ?? item.description ?? "")}</Text>',
    "          </Pressable>",
    "        )}",
    "      />",
    "    </View>",
    "  );",
    "}",
    "",
    "const styles = StyleSheet.create({",
    '  container: { flex: 1, backgroundColor: "#0f172a", padding: 16, gap: 12 },',
    '  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },',
    '  title: { color: "#f8fafc", fontSize: 20, fontWeight: "600" },',
    '  action: { color: "#93c5fd" },',
    '  row: { backgroundColor: "#1e293b", padding: 14, borderRadius: 8, marginBottom: 8 },',
    '  rowTitle: { color: "#f8fafc", fontWeight: "600" },',
    '  muted: { color: "#94a3b8" },',
    '  error: { color: "#fca5a5" },',
    "});",
    "",
  ].join("\n");

  const detailScreen = [
    'import React from "react";',
    'import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";',
    'import { detailFieldNames } from "../schema";',
    'import type { ListRow } from "./ListScreen";',
    "",
    "export function DetailScreen({ row, onBack }: { row: ListRow; onBack: () => void }) {",
    "  return (",
    '    <ScrollView style={styles.container} contentContainerStyle={styles.content}>',
    '      <Pressable onPress={onBack}><Text style={styles.action}>Back</Text></Pressable>',
    "      {detailFieldNames.map((field) => (",
    '        <View key={field} style={styles.block}>',
    '          <Text style={styles.label}>{field}</Text>',
    '          <Text style={styles.value}>{String(row[field] ?? "—")}</Text>',
    "        </View>",
    "      ))}",
    "    </ScrollView>",
    "  );",
    "}",
    "",
    "const styles = StyleSheet.create({",
    '  container: { flex: 1, backgroundColor: "#0f172a" },',
    '  content: { padding: 16, gap: 12 },',
    '  action: { color: "#93c5fd", paddingBottom: 8 },',
    '  block: { backgroundColor: "#1e293b", padding: 14, borderRadius: 8 },',
    '  label: { color: "#94a3b8", fontSize: 12, textTransform: "uppercase" },',
    '  value: { color: "#f8fafc", fontSize: 16 },',
    "});",
    "",
  ].join("\n");

  const formScreen = [
    'import React, { useState } from "react";',
    'import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";',
    'import { client } from "../api";',
    'import { defaultCollection } from "../config";',
    'import { collectionFields } from "../schema";',
    'import { validateRow } from "../validation";',
    "",
    "export function FormScreen({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {",
    "  const [values, setValues] = useState<Record<string, string>>({});",
    "  const [errors, setErrors] = useState<Record<string, string>>({});",
    "",
    "  async function submit() {",
    "    const validation = validateRow(collectionFields, values);",
    "    setErrors(validation);",
    "    if (Object.keys(validation).length) return;",
    "    try {",
    "      await client.from(defaultCollection).create(values);",
    "      onDone();",
    "    } catch (cause) {",
    '      Alert.alert("Could not save", cause instanceof Error ? cause.message : "Request failed");',
    "    }",
    "  }",
    "",
    "  return (",
    '    <ScrollView style={styles.container} contentContainerStyle={styles.content}>',
    "      {collectionFields.map((field) => (",
    '        <View key={field.name} style={styles.block}>',
    '          <Text style={styles.label}>{field.name}{field.required ? " *" : ""}</Text>',
    '          <TextInput',
    '            style={styles.input}',
    "            value={values[field.name] ?? \"\"}",
    "            onChangeText={(text) => setValues({ ...values, [field.name]: text })}",
    '            keyboardType={field.type === "decimal" || field.type === "integer" ? "numeric" : "default"}',
    "          />",
    "          {errors[field.name] ? <Text style={styles.error}>{errors[field.name]}</Text> : null}",
    "        </View>",
    "      ))}",
    '      <Pressable style={styles.button} onPress={() => void submit()}><Text style={styles.buttonText}>Save</Text></Pressable>',
    '      <Pressable onPress={onCancel}><Text style={styles.action}>Cancel</Text></Pressable>',
    "    </ScrollView>",
    "  );",
    "}",
    "",
    "const styles = StyleSheet.create({",
    '  container: { flex: 1, backgroundColor: "#0f172a" },',
    '  content: { padding: 16, gap: 12 },',
    '  block: { gap: 4 },',
    '  label: { color: "#94a3b8", fontSize: 12, textTransform: "uppercase" },',
    '  input: { backgroundColor: "#1e293b", color: "#f8fafc", padding: 12, borderRadius: 8 },',
    '  button: { backgroundColor: "#2563eb", padding: 14, borderRadius: 8, alignItems: "center" },',
    '  buttonText: { color: "#fff", fontWeight: "600" },',
    '  action: { color: "#93c5fd", textAlign: "center", paddingVertical: 8 },',
    '  error: { color: "#fca5a5" },',
    "});",
    "",
  ].join("\n");

  const appTsx = [
    'import React, { useCallback, useEffect, useState } from "react";',
    'import { StatusBar } from "expo-status-bar";',
    'import * as Linking from "expo-linking";',
    'import { client, handleAuthDeepLink } from "./src/api";',
    'import { AuthScreen } from "./src/screens/AuthScreen";',
    'import { DetailScreen } from "./src/screens/DetailScreen";',
    'import { FormScreen } from "./src/screens/FormScreen";',
    'import { ListScreen, type ListRow } from "./src/screens/ListScreen";',
    "",
    'type Route = { name: "list" } | { name: "detail"; row: ListRow } | { name: "form" };',
    "",
    "export default function App() {",
    "  const [signedIn, setSignedIn] = useState(false);",
    '  const [route, setRoute] = useState<Route>({ name: "list" });',
    "",
    "  const refreshSession = useCallback(async () => {",
    "    const user = await client.auth.getUser();",
    "    setSignedIn(Boolean(user));",
    "  }, []);",
    "",
    "  useEffect(() => {",
    "    void refreshSession();",
    '    const subscription = Linking.addEventListener("url", ({ url }) => {',
    "      void handleAuthDeepLink(url).then(() => refreshSession());",
    "    });",
    "    void Linking.getInitialURL().then((url) => (url ? handleAuthDeepLink(url) : undefined)).catch(() => undefined);",
    "    return () => subscription.remove();",
    "  }, [refreshSession]);",
    "",
    "  if (!signedIn) return (<><AuthScreen onSignedIn={() => void refreshSession()} /><StatusBar style=\"light\" /></>);",
    "",
    "  if (route.name === \"detail\") return (<><DetailScreen row={route.row} onBack={() => setRoute({ name: \"list\" })} /><StatusBar style=\"light\" /></>);",
    "  if (route.name === \"form\") return (<><FormScreen onDone={() => setRoute({ name: \"list\" })} onCancel={() => setRoute({ name: \"list\" })} /><StatusBar style=\"light\" /></>);",
    "",
    "  return (",
    "    <>",
    "      <ListScreen",
    "        onOpen={(row) => setRoute({ name: \"detail\", row })}",
    "        onCreate={() => setRoute({ name: \"form\" })}",
    "        onSignOut={() => void client.auth.signOut().then(refreshSession)}",
    "      />",
    '      <StatusBar style="light" />',
    "    </>",
    "  );",
    "}",
    "",
  ].join("\n");

  const readme = [
    `# ${options.name} (Expo / React Native)`,
    "",
    "This mobile app shares the Project API and Project Auth of its DataBackend with the website:",
    "the same end users, collections, access policies and RLS apply to both clients.",
    "",
    "## Rules",
    "- The app uses **only** `PROJECT_PUBLISHABLE_KEY` (public, does not bypass permissions or RLS).",
    "- `PROJECT_SECRET_KEY`, `DATABASE_URL` and any database role credentials must never appear in the",
    "  app bundle, source files, logs or prompts.",
    "- Refresh tokens are stored with `expo-secure-store` (Keychain/Keystore), never plain AsyncStorage.",
    "- Email verification and password reset come back through the app deep link scheme `" + scheme + "://`.",
    "  Every redirect target must be registered in Data Studio → Authentication → Redirect URLs first.",
    "",
    "## Scripts",
    "- `npm run web` – Expo Web (used by Live Preview in the sandbox)",
    "- `npm start` – Metro for a device or simulator (not part of Live Preview)",
    "",
    "## Out of scope (D6)",
    "Store builds and publishing are not implemented: the BuildProvider boundary is a documented TODO.",
    "Ask the owner to approve a store build once Apple/Google credentials and signing are configured.",
    "",
  ].join("\n");

  return {
    framework: MOBILE_APP_FRAMEWORK,
    devCommand: `npx expo export --platform web --output-dir dist && npx -y serve -s dist -l ${MOBILE_APP_PREVIEW_PORT}`,
    port: MOBILE_APP_PREVIEW_PORT,
    files: {
      "package.json": packageJson,
      "app.config.js": appConfig,
      "tsconfig.json": tsconfig,
      "App.tsx": appTsx,
      "README.md": readme,
      "src/config.ts": configTs,
      "src/api.ts": apiTs,
      "src/validation.ts": validationTs,
      "src/schema.ts": schemaTs,
      "src/screens/AuthScreen.tsx": authScreen,
      "src/screens/ListScreen.tsx": listScreen,
      "src/screens/DetailScreen.tsx": detailScreen,
      "src/screens/FormScreen.tsx": formScreen,
    },
  };
}

/** Field types accepted by the mobile form validator; kept for parity checks with Data Studio. */
export const MOBILE_APP_FIELD_TYPES = ["string", "text", "integer", "decimal", "boolean", "date", "datetime", "json", "uuid", "enum"] as const;
export type MobileAppFieldType = ReturnType<typeof scalarFieldType>;
