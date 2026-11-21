set shell := ["bash", "-uc"]

# List available recipes
default:
    @just --list

# Install dependencies and build
install:
    npm install
    npm run build

# Build the CLI bundle (also refreshes the plugin's copy)
build:
    npm run build

# Point Firefox and Claude at your local build
setup: build
    node packages/daemon/dist/sharepane.mjs setup

# Check every piece of a local install
doctor:
    node packages/daemon/dist/sharepane.mjs doctor

# Typecheck the helper
typecheck:
    npm run typecheck

# Run the test suite (vitest)
test:
    npm test

# Lint the Firefox extension (web-ext)
lint:
    npm run lint:extension

# Everything CI checks
check: typecheck test lint build
    node scripts/version.mjs check
    node scripts/check-plugin.mjs plugins/sharepane

# Remove build output and dependencies
clean:
    rm -rf packages/daemon/dist node_modules packages/*/node_modules
