FROM node:erbium-stretch AS build

ENV INPUT_FOLDER './sample/*'
ENV NEO4J_URL 'bolt://localhost:7687'
ENV NEO4J_USER 'neo4j'
ENV NEO4J_PASSWORD 'bloodhound'
ENV DELETE_PROCESSED true

WORKDIR /app
COPY package*.json ./
COPY .babelrc ./
RUN npm install
COPY ./src ./src
RUN npm run build

FROM node:erbium-stretch
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY --from=build /app/dist ./dist

VOLUME [ "/app/data" ]

CMD [ "npm", "start" ]
