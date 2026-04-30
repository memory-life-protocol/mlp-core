# FalkorDB Connector

Reference implementation of StorageAdapter using FalkorDB.
Graph traversal and vector similarity in one store.

## StorageAdapter
File: adapter.ts
Requires: FALKORDB_HOST, FALKORDB_PORT

## Deploy FalkorDB
Docker locally:
  docker run -p 6379:6379 falkordb/falkordb

Railway:
  Add FalkorDB as a service.
  Set FALKORDB_HOST to falkordb.railway.internal
  Set FALKORDB_PORT to 6379

## Swap this connector
Implement StorageAdapter from src/interfaces/ with any database.
Neo4j, Postgres, SQLite, or any graph database works.
Nothing else in the protocol changes.
