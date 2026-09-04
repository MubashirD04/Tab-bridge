set shell := ["bash", "-uc"]

# List available recipes
default:
    @just --list

# Install workspace deps, build, and link the `tab-bridge` CLI onto PATH
install:
    npm install
    npm run build
    cd packages/daemon && npm link

# Build all workspace packages
build:
    npm run build

# Typecheck all workspace packages
typecheck:
    npm run typecheck

# Run the test suite (vitest)
test:
    npm test

# Lint the Firefox extension (web-ext)
lint:
    npm run lint:extension

# Everything CONTRIBUTING.md asks for before opening a PR
check: typecheck test lint

# Undo `just install`: remove the global CLI link and all build/dep output
uninstall:
    cd packages/daemon && npm uninstall --global tab-bridge-daemon || true
    rm -rf packages/*/dist node_modules packages/*/node_modules
