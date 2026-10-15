package com.scisoftware.scisonomics

import android.animation.ValueAnimator
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.setBackgroundColor(Color.rgb(2,6,23))
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The system owns the single launch splash on Android 12+. No keep-on-
    // screen condition, auth work or financial initialization waits for it.
    if (savedInstanceState == null && Build.VERSION.SDK_INT >= 31) {
      splashScreen.setOnExitAnimationListener { splash ->
        val motion = ValueAnimator.areAnimatorsEnabled()
        val icon = splash.iconView
        if (icon == null) { splash.remove(); return@setOnExitAnimationListener }
        icon.apply {
          alpha = if (motion) 0f else 1f
          scaleX = if (motion) .92f else 1f
          scaleY = scaleX
          animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(if (motion) 500L else 0L)
            .withEndAction {
              splash.animate().alpha(0f).setDuration(if (motion) 120L else 0L)
                .withEndAction { splash.remove() }.start()
            }.start()
        }
      }
    } else if (savedInstanceState == null) {
      // API 24–30: continue the same logo/background from the starting window.
      // A native overlay disappears after 620ms without holding the WebView.
      val root = findViewById<ViewGroup>(android.R.id.content)
      val overlay = FrameLayout(this).apply { setBackgroundColor(Color.rgb(2,6,23)) }
      val size = (108 * resources.displayMetrics.density).toInt()
      val logo = ImageView(this).apply {
        setImageResource(R.mipmap.ic_launcher_foreground)
        scaleType = ImageView.ScaleType.FIT_CENTER
      }
      overlay.addView(logo,FrameLayout.LayoutParams(size,size,Gravity.CENTER))
      root.addView(overlay,ViewGroup.LayoutParams(-1,-1))
      val motion = Build.VERSION.SDK_INT < 26 || ValueAnimator.areAnimatorsEnabled()
      logo.alpha = if (motion) 0f else 1f
      logo.scaleX = if (motion) .92f else 1f; logo.scaleY = logo.scaleX
      logo.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(if (motion) 500L else 0L)
        .withEndAction {
          overlay.animate().alpha(0f).setDuration(if (motion) 120L else 0L)
            .withEndAction { root.removeView(overlay) }.start()
        }.start()
    }
  }
}
