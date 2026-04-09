FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx tsc
EXPOSE 4000
CMD ["node", "dist/app.js"]
