import { Platform, type GestureResponderEvent, type PointerEvent } from 'react-native';

export interface ControlPoint {
  id: string;
  x: number;
  y: number;
}

// These DOM methods are only used in the web branch. iOS supplies per-control
// local coordinates; Android must route contacts using RootReactView coordinates.
interface WebSurface {
  getBoundingClientRect(): { left: number; top: number };
  contains(target: unknown): boolean;
  setPointerCapture(id: number): void;
}

export function changedTouchIds(event: GestureResponderEvent): string[] {
  return Array.from(event.nativeEvent.changedTouches, (touch) => String(touch.identifier));
}

export interface ControlBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Android's JSTouchDispatcher retains the first targetTag for the entire
// gesture, including ACTION_POINTER_DOWN. locationX/Y therefore cannot tell
// us which control a later finger touched. TouchesHelper's pageX/Y, like the
// pageX/Y returned by View.measure (NOT measureInWindow), use RootReactView.
export function rootTouchPoints(event: GestureResponderEvent): ControlPoint[] {
  return Array.from(event.nativeEvent.changedTouches, (touch) => ({
    id: String(touch.identifier),
    x: touch.pageX,
    y: touch.pageY,
  }));
}

export function containsPoint(bounds: ControlBounds, point: ControlPoint, hitSlop = 0): boolean {
  return point.x >= bounds.x - hitSlop && point.y >= bounds.y - hitSlop
    && point.x <= bounds.x + bounds.width + hitSlop
    && point.y <= bounds.y + bounds.height + hitSlop;
}

export function controlTouchPoints(event: GestureResponderEvent, starting: boolean): ControlPoint[] {
  if (Platform.OS !== 'web') {
    const { identifier, locationX, locationY } = event.nativeEvent;
    return [{ id: String(identifier), x: locationX, y: locationY }];
  }
  const surface = event.currentTarget as unknown as WebSurface;
  const rect = surface.getBoundingClientRect();
  // Raw RN Web touch events are DOM TouchEvents, not responder-normalized RN
  // coordinates. A batched touchStart may include contacts on other controls.
  const touches = Array.from(
    event.nativeEvent.changedTouches as unknown as ArrayLike<{
      identifier: number; clientX: number; clientY: number; target: unknown;
    }>,
  );
  return touches
    .filter((touch) => !starting || surface.contains(touch.target))
    .map((touch) => ({
      id: String(touch.identifier),
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top,
    }));
}

export function mousePoint(event: PointerEvent): ControlPoint {
  const rect = (event.currentTarget as unknown as WebSurface).getBoundingClientRect();
  return {
    id: `mouse:${event.nativeEvent.pointerId}`,
    x: event.nativeEvent.clientX - rect.left,
    y: event.nativeEvent.clientY - rect.top,
  };
}

export function captureMouse(event: PointerEvent) {
  (event.currentTarget as unknown as WebSurface).setPointerCapture(event.nativeEvent.pointerId);
}