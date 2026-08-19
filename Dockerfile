FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY config ./config
ENV PORT=4321
EXPOSE 4321
CMD ["npm", "start"]
