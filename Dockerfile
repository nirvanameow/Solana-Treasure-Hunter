FROM node:16-alpine
WORKDIR /usr/src/app

COPY . .

RUN npm install --only=production

EXPOSE 3000

CMD ["node", "index.js"]
