package expo.modules.zenulatorinput

import android.app.Activity
import android.content.Context
import android.hardware.input.InputManager
import android.os.Handler
import android.os.Looper
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Window
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android WebView (Chromium) does not expose the Gamepad API, and hardware key
 * events only reach a focused WebView DOM unreliably. While gameplay capture is
 * enabled this module wraps the Activity's Window.Callback, forwards external
 * keyboard / controller keys and joystick axes to JS, and consumes them so they
 * are not delivered twice. System keys (Back, volume, media, power, home) are
 * always passed through untouched. Capture is off outside the emulator screen.
 */
class ZenulatorInputModule : Module() {
  private var captureEnabled = false
  private var installedWindow: Window? = null
  private var originalCallback: Window.Callback? = null
  private val lastAxes = HashMap<Int, IntArray>()
  /** Physical keys whose DOWN we forwarded: "deviceId:keyCode" -> gamepad flag. */
  private val forwardedDown = HashMap<String, Boolean>()
  private val mainHandler = Handler(Looper.getMainLooper())

  private val deviceListener = object : InputManager.InputDeviceListener {
    override fun onInputDeviceAdded(deviceId: Int) { emitDevice(deviceId, true) }
    override fun onInputDeviceRemoved(deviceId: Int) {
      lastAxes.remove(deviceId)
      releaseForwarded(deviceId)
      sendEvent("onDeviceChange", mapOf("deviceId" to deviceId, "connected" to false, "name" to ""))
    }
    override fun onInputDeviceChanged(deviceId: Int) { emitDevice(deviceId, true) }
  }
  private var listeningDevices = false

  override fun definition() = ModuleDefinition {
    Name("ZenulatorInput")
    Events("onInput", "onDeviceChange")

    Function("isSupported") { true }

    Function("setCaptureEnabled") { enabled: Boolean ->
      captureEnabled = enabled
      mainHandler.post {
        if (enabled) install() else uninstall()
      }
    }

    Function("getControllers") {
      InputDevice.getDeviceIds().toList().mapNotNull { id ->
        val device = InputDevice.getDevice(id) ?: return@mapNotNull null
        if (!isController(device)) null else mapOf("deviceId" to id, "name" to device.name)
      }
    }

    OnActivityEntersForeground { if (captureEnabled) mainHandler.post { install() } }
    OnActivityEntersBackground {
      // JS also releases on AppState change; this keeps native state clean.
      lastAxes.clear()
      mainHandler.post { releaseForwarded() }
    }
    OnDestroy { mainHandler.post { uninstall() } }
  }

  private fun currentActivity(): Activity? = appContext.currentActivity

  private fun install() {
    val activity = currentActivity() ?: return
    val window = activity.window ?: return
    if (installedWindow === window) return
    uninstall()
    val base = window.callback ?: return
    originalCallback = base
    installedWindow = window
    window.callback = ForwardingCallback(base)
    if (!listeningDevices) {
      val manager = activity.getSystemService(Context.INPUT_SERVICE) as? InputManager
      manager?.registerInputDeviceListener(deviceListener, mainHandler)
      listeningDevices = manager != null
    }
  }

  private fun uninstall() {
    val window = installedWindow
    val base = originalCallback
    if (window != null && base != null && window.callback is ForwardingCallback) {
      window.callback = base
    }
    installedWindow = null
    originalCallback = null
    lastAxes.clear()
    releaseForwarded()
    if (listeningDevices) {
      val manager = currentActivity()?.getSystemService(Context.INPUT_SERVICE) as? InputManager
      manager?.unregisterInputDeviceListener(deviceListener)
      listeningDevices = false
    }
  }

  private fun isController(device: InputDevice): Boolean {
    val sources = device.sources
    return (sources and InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD ||
      (sources and InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK
  }

  private fun emitDevice(deviceId: Int, connected: Boolean) {
    val device = InputDevice.getDevice(deviceId) ?: return
    if (!isController(device)) return
    sendEvent("onDeviceChange", mapOf("deviceId" to deviceId, "connected" to connected, "name" to device.name))
  }

  private fun isSystemKey(keyCode: Int): Boolean = when (keyCode) {
    KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_POWER,
    KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN, KeyEvent.KEYCODE_VOLUME_MUTE,
    KeyEvent.KEYCODE_APP_SWITCH, KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_ESCAPE,
    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE,
    KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_TAB -> true
    else -> false
  }

  /** Returns true when the event was forwarded and must be consumed. */
  fun handleKey(event: KeyEvent): Boolean {
    val keyCode = event.keyCode
    val physicalId = "${event.deviceId}:$keyCode"
    // Always deliver the release for a key we already forwarded, even if a
    // modifier went down in between (X down, Ctrl down, X up) or capture was
    // just turned off; otherwise the GBA key would stay latched.
    if (event.action == KeyEvent.ACTION_UP && forwardedDown.containsKey(physicalId)) {
      val wasGamepad = forwardedDown.remove(physicalId) ?: false
      emitButton(keyCode, false, wasGamepad, event.deviceId)
      return true
    }
    if (!captureEnabled) return false
    if (isSystemKey(keyCode)) return false
    // NEW Ctrl/Alt/Meta shortcuts stay OS-owned, mirroring the browser rule.
    if (event.isCtrlPressed || event.isAltPressed || event.isMetaPressed) return false
    val source = event.source
    val hasKeyboardSource = (source and InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD
    val gamepad = KeyEvent.isGamepadButton(keyCode) ||
      (source and InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD ||
      (source and InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK ||
      (event.device?.let { isController(it) } ?: false) ||
      // D-pad-only controllers report KEYCODE_DPAD_* with SOURCE_DPAD only.
      ((source and InputDevice.SOURCE_DPAD) == InputDevice.SOURCE_DPAD && !hasKeyboardSource)
    val externalKeyboard = (source and InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD &&
      event.device?.isVirtual == false
    if (!gamepad && !externalKeyboard) return false
    if (event.action == KeyEvent.ACTION_MULTIPLE) return true
    val pressed = event.action == KeyEvent.ACTION_DOWN
    if (!pressed) return true // unmatched UP (its DOWN was not ours)
    if (event.repeatCount > 0) return true
    forwardedDown[physicalId] = gamepad
    emitButton(keyCode, true, gamepad, event.deviceId)
    return true
  }

  private fun emitButton(keyCode: Int, pressed: Boolean, gamepad: Boolean, deviceId: Int) {
    sendEvent("onInput", mapOf(
      "kind" to "button",
      "keyCode" to keyCode,
      "pressed" to pressed,
      "gamepad" to gamepad,
      "deviceId" to deviceId,
    ))
  }

  /** Emit releases for everything still held (background, uninstall, unplug). */
  private fun releaseForwarded(deviceId: Int? = null) {
    val keys = forwardedDown.keys.filter { deviceId == null || it.startsWith("$deviceId:") }
    keys.forEach { id ->
      val gamepad = forwardedDown.remove(id) ?: false
      val parts = id.split(":")
      emitButton(parts[1].toInt(), false, gamepad, parts[0].toInt())
    }
  }

  private fun quantize(value: Float): Int = if (value < -0.5f) -1 else if (value > 0.5f) 1 else 0

  fun handleMotion(event: MotionEvent): Boolean {
    if (!captureEnabled) return false
    val joystick = (event.source and InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK
    if (!joystick || event.action != MotionEvent.ACTION_MOVE) return false
    val x = quantize(event.getAxisValue(MotionEvent.AXIS_X))
    val y = quantize(event.getAxisValue(MotionEvent.AXIS_Y))
    val hatX = quantize(event.getAxisValue(MotionEvent.AXIS_HAT_X))
    val hatY = quantize(event.getAxisValue(MotionEvent.AXIS_HAT_Y))
    val lt = if (maxOf(event.getAxisValue(MotionEvent.AXIS_LTRIGGER), event.getAxisValue(MotionEvent.AXIS_BRAKE)) > 0.5f) 1 else 0
    val rt = if (maxOf(event.getAxisValue(MotionEvent.AXIS_RTRIGGER), event.getAxisValue(MotionEvent.AXIS_GAS)) > 0.5f) 1 else 0
    val next = intArrayOf(x, y, hatX, hatY, lt, rt)
    val previous = lastAxes[event.deviceId]
    if (previous == null || !previous.contentEquals(next)) {
      lastAxes[event.deviceId] = next
      sendEvent("onInput", mapOf(
        "kind" to "axis",
        "deviceId" to event.deviceId,
        "x" to (if (hatX != 0) hatX else x),
        "y" to (if (hatY != 0) hatY else y),
        "leftTrigger" to (lt == 1),
        "rightTrigger" to (rt == 1),
      ))
    }
    return true
  }

  private inner class ForwardingCallback(private val base: Window.Callback) : Window.Callback by base {
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
      return handleKey(event) || base.dispatchKeyEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
      return handleMotion(event) || base.dispatchGenericMotionEvent(event)
    }
  }
}
