FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install edge-tts --break-system-packages && \
    apt-get clean

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
