/** Runnable starters for the stacks the Projects page offers beyond the website adapters, the game and Expo. */
export const STACK_STARTER_IDS = ["vue", "phaser", "three", "flutter"] as const;
export type StackStarterId = typeof STACK_STARTER_IDS[number];

export function isStackStarterId(value: unknown): value is StackStarterId {
  return typeof value === "string" && (STACK_STARTER_IDS as readonly string[]).includes(value);
}

const html = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dart = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\$/g, "\\$").replace(/\r?\n/g, " ")}'`;
const packageJson = (dependencies: Record<string, string>, devDependencies: Record<string, string>) => `${JSON.stringify({
  name: "npati-starter", private: true, version: "1.0.0", type: "module",
  scripts: { dev: "vite --host 0.0.0.0", build: "vite build", preview: "vite preview --host 0.0.0.0" },
  dependencies, devDependencies,
}, null, 2)}\n`;
const page = (name: string, body: string, entry: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${html(name)}</title>
  </head>
  <body>
    ${body}
    <script type="module" src="${entry}"></script>
  </body>
</html>
`;
const FULL_PAGE = "html, body { margin: 0; height: 100%; background: #0f172a; overflow: hidden; }\n";

function vue(name: string): Record<string, string> {
  return {
    "package.json": packageJson({ vue: "^3.5.13" }, { vite: "^6.0.7", "@vitejs/plugin-vue": "^5.2.1" }),
    "vite.config.js": 'import { defineConfig } from "vite";\nimport vue from "@vitejs/plugin-vue";\n\nexport default defineConfig({ plugins: [vue()] });\n',
    "index.html": page(name, '<div id="app"></div>', "/src/main.js"),
    "src/main.js": 'import { createApp } from "vue";\nimport App from "./App.vue";\nimport "./styles.css";\n\ncreateApp(App).mount("#app");\n',
    "src/App.vue": `<script setup>
import { ref } from "vue";

const title = ${JSON.stringify(name)};
const count = ref(0);
</script>

<template>
  <main class="app">
    <h1>{{ title }}</h1>
    <p>Vue 3 + Vite</p>
    <button type="button" @click="count += 1">Count: {{ count }}</button>
  </main>
</template>
`,
    "src/styles.css": "body { margin: 0; font-family: system-ui, sans-serif; color: #172033; background: #f1f5f9; }\n.app { max-width: 720px; margin: 64px auto; padding: 0 16px; }\nbutton { padding: 10px 16px; border: 0; border-radius: 8px; color: #fff; background: #0f766e; font: inherit; cursor: pointer; }\n",
  };
}

function phaser(name: string): Record<string, string> {
  return {
    "package.json": packageJson({ phaser: "^3.90.0" }, { vite: "^6.0.7" }),
    "index.html": page(name, '<div id="game"></div>', "/src/main.js"),
    "src/styles.css": `${FULL_PAGE}#game { width: 100%; height: 100%; }\n`,
    "src/main.js": `import Phaser from "phaser";
import "./styles.css";

const PLATFORMS = [[400, 588, 800], [620, 450, 220], [180, 340, 220], [620, 230, 200]];

class Level extends Phaser.Scene {
  create() {
    this.player = this.add.rectangle(100, 480, 32, 48, 0xffcf4a);
    this.physics.add.existing(this.player);
    this.player.body.setCollideWorldBounds(true);
    for (const [x, y, width] of PLATFORMS) {
      const platform = this.add.rectangle(x, y, width, 24, 0x22c55e);
      this.physics.add.existing(platform, true);
      this.physics.add.collider(this.player, platform);
    }
    this.keys = this.input.keyboard.createCursorKeys();
    this.add.text(16, 16, "Arrows: move. Up or Space: jump.", { color: "#ffffff", fontSize: "18px" });
  }

  update() {
    const body = this.player.body;
    body.setVelocityX(this.keys.left.isDown ? -240 : this.keys.right.isDown ? 240 : 0);
    if ((this.keys.up.isDown || this.keys.space.isDown) && body.blocked.down) body.setVelocityY(-560);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 800,
  height: 600,
  backgroundColor: "#172033",
  physics: { default: "arcade", arcade: { gravity: { y: 1000 } } },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: Level,
});
`,
  };
}

function three(name: string): Record<string, string> {
  return {
    "package.json": packageJson({ three: "^0.180.0" }, { vite: "^6.0.7" }),
    "index.html": page(name, '<canvas id="scene"></canvas>', "/src/main.js"),
    "src/styles.css": `${FULL_PAGE}#scene { display: block; width: 100%; height: 100%; }\n`,
    "src/main.js": `import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import "./styles.css";

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f172a);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
camera.position.set(4, 3, 6);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const light = new THREE.DirectionalLight(0xffffff, 2);
light.position.set(5, 8, 4);
scene.add(light);

const cube = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshStandardMaterial({ color: 0x38bdf8 }));
cube.position.x = -1.6;
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.9, 40, 24), new THREE.MeshStandardMaterial({ color: 0xf97316 }));
ball.position.x = 1.6;
const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshStandardMaterial({ color: 0x334155 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -1;
scene.add(cube, ball, floor);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

renderer.setAnimationLoop(() => {
  cube.rotation.y += 0.01;
  controls.update();
  renderer.render(scene, camera);
});
`,
  };
}

function flutter(name: string): Record<string, string> {
  return {
    "pubspec.yaml": "name: npati_mobile\ndescription: NPATI Flutter application\npublish_to: none\nversion: 1.0.0+1\nenvironment:\n  sdk: '>=3.4.0 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\nflutter:\n  uses-material-design: true\n",
    "web/index.html": `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${html(name)}</title>
  </head>
  <body>
    <script src="flutter_bootstrap.js" async></script>
  </body>
</html>
`,
    "lib/main.dart": `import 'package:flutter/material.dart';

void main() => runApp(const StarterApp());

class StarterApp extends StatelessWidget {
  const StarterApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: ${dart(name)},
      theme: ThemeData(colorSchemeSeed: Colors.teal),
      home: const ItemsPage(),
    );
  }
}

class ItemsPage extends StatefulWidget {
  const ItemsPage({super.key});

  @override
  State<ItemsPage> createState() => _ItemsPageState();
}

class _ItemsPageState extends State<ItemsPage> {
  final _items = <String>[];
  final _field = TextEditingController();

  void _add() {
    final text = _field.text.trim();
    if (text.isEmpty) return;
    setState(() => _items.add(text));
    _field.clear();
  }

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text(${dart(name)})),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: TextField(controller: _field, onSubmitted: (_) => _add()),
          ),
          Expanded(
            child: ListView(children: [for (final item in _items) ListTile(title: Text(item))]),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(onPressed: _add, child: const Icon(Icons.add)),
    );
  }
}
`,
  };
}

const BUILDERS: Record<StackStarterId, (name: string) => Record<string, string>> = { vue, phaser, three, flutter };

export function createStackStarterScaffold(id: StackStarterId, options: { name: string }): { files: Record<string, string> } {
  return { files: BUILDERS[id](options.name) };
}
