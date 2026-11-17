# Dairy Plant Atlas — container build for Railway (or any Docker host).
#
# Railway picks this file up on its own ("Using detected Dockerfile!"),
# so the deploy no longer depends on railway.json or on the Nixpacks
# builder, both of which Railway has deprecated.
#
# The SQLite database is NOT in the image. It lives on the Railway volume
# mounted at /data (PLANT_TRACK_DB=/data/plant_track.db), so rebuilding
# or redeploying never touches the data.

# ---- build stage: install dependencies (better-sqlite3 is native) ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# Compiler toolchain is only a fallback: better-sqlite3 normally downloads
# a prebuilt binary and never needs it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Railway sets PORT itself; this is the fallback and matches the port the
# public domain is pointed at.
ENV PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 8080
# "npm start" runs prestart first: apply the schema (create-if-missing)
# and reload the seed CSVs. Both are safe to repeat against live data.
# Runs as root on purpose: Railway mounts volumes root-owned.
CMD ["npm", "start"]
