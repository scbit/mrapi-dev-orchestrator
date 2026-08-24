FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY README.md ./

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
