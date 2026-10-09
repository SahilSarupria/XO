#!/usr/bin/env bash
# Internal scaffolding helper — not part of the shipped CLI.
# Usage: gen-pkg.sh <dir> <pkg-name> <description> <deps-json> <refs-json>
set -euo pipefail
DIR="$1"; NAME="$2"; DESC="$3"; DEPS="$4"; REFS="$5"

cat > "$DIR/package.json" <<EOF
{
  "name": "@xo/${NAME}",
  "version": "0.1.0",
  "private": true,
  "description": "${DESC}",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -b tsconfig.json",
    "clean": "rm -rf dist *.tsbuildinfo",
    "test": "node --import tsx --test test/**/*.test.ts",
    "test:coverage": "node --import tsx --experimental-test-coverage --test test/**/*.test.ts"
  },
  "dependencies": ${DEPS},
  "devDependencies": {
    "tsx": "^4.16.0"
  }
}
EOF

cat > "$DIR/tsconfig.json" <<EOF
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "references": ${REFS}
}
EOF
