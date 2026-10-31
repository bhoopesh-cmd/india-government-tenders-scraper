FROM apify/actor-node:24

WORKDIR /home/myuser
RUN node -e "const [major,minor,patch]=process.versions.node.split('.').map(Number); if(major!==24 || minor<22 || (minor===22 && patch<1)) throw new Error('A patched Node 24.22.1+ runtime is required')"

COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false && npm ci --include=dev --omit=optional

COPY --chown=myuser . ./
RUN npm run build
RUN npm prune --omit=dev --omit=optional --no-package-lock

CMD ["node", "dist/main.js"]
