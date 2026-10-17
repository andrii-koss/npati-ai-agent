#!/usr/bin/env bash
set -e

DIR="/projects/test-next-build"
rm -rf "$DIR"
mkdir -p "$DIR/pages"

cat > "$DIR/package.json" << 'EOF'
{
  "name": "test-next-app",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "build": "next build"
  },
  "dependencies": {
    "next": "^14.2.14",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "typescript": "^5"
  }
}
EOF

cat > "$DIR/pages/index.js" << 'EOF'
export default function Home() {
  return <h1>Live Verification of Next Build in Isolated Sandbox</h1>;
}
EOF

cd "$DIR"
node /opt/npati-runtime/prepare-project-dependencies.cjs install
./node_modules/.bin/next build
echo "NEXT_BUILD_SUCCESS"
