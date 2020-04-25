This script watches for BloodHound json and zip in the `data/` folder and sends them to Neo4j.

It is only a proof of concept, do not use in production!

# Build

`docker build . -t bloodhound-autoprocess`

# Run

`docker run --rm -v $(pwd)/data:/app/data  --name bh bloodhound-autoprocess`
