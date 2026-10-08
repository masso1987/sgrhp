package com.ciblerh.hr_employee_portal

import android.os.SystemClock
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channel = "sgrhp/boot_clock"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channel).setMethodCallHandler { call, result ->
            when (call.method) {
                // Monotonic milliseconds since boot (includes deep sleep). Not affected
                // by changes to the wall clock — used to anchor offline punch times.
                "elapsedRealtime" -> result.success(SystemClock.elapsedRealtime())
                else -> result.notImplemented()
            }
        }
    }
}
