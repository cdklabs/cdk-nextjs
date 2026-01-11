/*
  Debug utilities for cache handlers
*/
/* eslint-disable import/no-extraneous-dependencies */
import debug from "debug";

export const getDebug = (namespace: string) => debug(namespace);
