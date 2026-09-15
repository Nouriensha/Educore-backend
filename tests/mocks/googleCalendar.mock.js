const mockGoogleCalendarService = {
  createCalendarEvent: jest.fn().mockImplementation((eventData) => Promise.resolve({
    id: `gcal_event_${Date.now()}`,
    htmlLink: 'https://calendar.google.com/event?action=VIEW',
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    status: 'confirmed'
  })),
  updateCalendarEvent: jest.fn().mockResolvedValue(true),
  deleteCalendarEvent: jest.fn().mockResolvedValue(true)
};

module.exports = {
  mockGoogleCalendarService
};
