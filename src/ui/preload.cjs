'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getAppStats:          () => ipcRenderer.invoke('get-app-stats'),
  getRecentEvents:      () => ipcRenderer.invoke('get-recent-events'),
  getPatterns:          () => ipcRenderer.invoke('get-patterns'),
  runAnalyze:           () => ipcRenderer.invoke('run-analyze'),
  getCollectionStatus:  () => ipcRenderer.invoke('get-collection-status'),
  toggleCollection: enable => ipcRenderer.invoke('toggle-collection', enable),
  getSettings:          () => ipcRenderer.invoke('get-settings'),
  saveSettings:      s  => ipcRenderer.invoke('save-settings', s),

  onCollectionStatus: cb => ipcRenderer.on('collection-status', (_, v) => cb(v)),
  onCollectorLog:     cb => ipcRenderer.on('collector-log',     (_, v) => cb(v)),
});
