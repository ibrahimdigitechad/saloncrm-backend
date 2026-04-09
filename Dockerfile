FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN chmod +x ./node_modules/.bin/tsc && ./node_modules/.bin/tsc
EXPOSE 4000
CMD ["node", "dist/app.js"]
