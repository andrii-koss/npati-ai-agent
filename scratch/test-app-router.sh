#!/usr/bin/env bash
set -e

DIR="/projects/test-app-router"
rm -rf "$DIR"
mkdir -p "$DIR/app"

cat > "$DIR/package.json" << 'EOF'
{
  "name": "test-app-router",
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

cat > "$DIR/tsconfig.json" << 'EOF'
{
  "compilerOptions": {
    "target": "es5",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
EOF

cat > "$DIR/app/layout.tsx" << 'EOF'
import React from "react";
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
EOF

cat > "$DIR/app/page.tsx" << 'EOF'
export default function Page() {
  return <h1>Hello Next.js App Router</h1>;
}
EOF

cd "$DIR"
node /opt/npati-runtime/prepare-project-dependencies.cjs install
./node_modules/.bin/next build
echo "NEXT_APP_ROUTER_BUILD_SUCCESS"
