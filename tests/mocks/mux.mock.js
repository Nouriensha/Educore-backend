const mockMuxClient = {
  video: {
    uploads: {
      create: jest.fn().mockImplementation(() => Promise.resolve({
        id: `mux_upload_${Date.now()}`,
        url: 'https://mux.mock/upload/url',
        status: 'waiting'
      })),
      retrieve: jest.fn().mockImplementation((uploadId) => Promise.resolve({
        id: uploadId,
        status: 'asset_created',
        asset_id: `mux_asset_${Date.now()}`
      }))
    },
    assets: {
      retrieve: jest.fn().mockImplementation((assetId) => Promise.resolve({
        id: assetId,
        status: 'ready',
        playback_ids: [{ id: 'mock_playback_id', policy: 'public' }],
        duration: 120.5
      })),
      delete: jest.fn().mockResolvedValue(true)
    }
  }
};

module.exports = {
  mockMuxClient
};
