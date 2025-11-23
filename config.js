const DEFAULT_SIGNALING_URL = 'ws://91.219.61.150:8080';
const DEFAULT_ROOM_NAME = 'room-1';

module.exports = {
  signalingUrl: process.env.SIGNALING_URL || DEFAULT_SIGNALING_URL,
  roomName: process.env.SIGNALING_ROOM || DEFAULT_ROOM_NAME,
  signalingPort: Number(process.env.SIGNALING_PORT || 8080),
  startLocalSignaling: (process.env.START_LOCAL_SIGNALING || '').toLowerCase() === 'true',
};
