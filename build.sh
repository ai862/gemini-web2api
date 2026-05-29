#!/usr/bin/env bash
cd "$(dirname "$0")/gemini-web2api-worker" && npm install && npx tsc --noEmit
