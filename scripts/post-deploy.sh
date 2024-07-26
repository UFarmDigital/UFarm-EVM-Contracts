#!/bin/bash

if [ -z "$1" ]
then
  echo "Error: no path to the directory for copying artifacts was specified."
  exit 1
fi

OZ_SOURCE_DIR="./.openzeppelin" 
ARTIFACTS_SOURCE_DIR="./artifacts"
DEPLOYMENTS_SOURCE_DIR="./deployments"
DEST_PATH="$1"

mkdir -p $DEST_PATH

# Copy the entire folders into the deployment-artifacts
cp -r ./.openzeppelin "$DEST_PATH"
cp -r ./artifacts "$DEST_PATH"
cp -r ./deployments "$DEST_PATH"

# Copy all deployments*.json files from the current directory into the combined_folder
cp deployments*.json "$DEST_PATH"

echo "Folders copied successfully into $DEST_PATH"
