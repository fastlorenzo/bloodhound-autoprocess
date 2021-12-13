FROM node:erbium-stretch AS build

WORKDIR /app
COPY package*.json ./
COPY webpack.config.*.js ./
RUN yarn install
COPY ./src ./src
RUN yarn run build


FROM node:erbium-stretch
LABEL author="Lorenzo Bernardi <docker@bernardi.be>"

WORKDIR /app
RUN mkdir /app/data
COPY package*.json ./
RUN yarn install
COPY --from=build /app/dist ./dist

ENV INPUT_FOLDER './data/*'
ENV NEO4J_URL 'bolt://localhost:7687'
ENV NEO4J_USER 'neo4j'
ENV NEO4J_PASSWORD 'bloodhound'
ENV DELETE_PROCESSED true

VOLUME [ "/app/data" ]

CMD [ "yarn", "start" ]
