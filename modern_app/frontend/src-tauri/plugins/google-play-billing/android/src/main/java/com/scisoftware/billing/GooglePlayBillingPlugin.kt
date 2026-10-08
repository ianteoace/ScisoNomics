package com.scisoftware.billing

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.android.billingclient.api.*
import org.json.JSONArray

@InvokeArg class CatalogArgs { var productIds:List<String> = emptyList(); var basePlanIds:List<String> = emptyList() }
@InvokeArg class PurchaseArgs { var productId="";var offerToken="";var obfuscatedAccountId="" }
@InvokeArg class ManagementArgs { var productId="" }

@TauriPlugin
class GooglePlayBillingPlugin(private val activity:Activity):Plugin(activity),PurchasesUpdatedListener {
    private val main=Handler(Looper.getMainLooper())
    private val gate=BillingGate()
    private val waiting=mutableListOf<Pair<Invoke,(BillingClient)->Unit>>()
    private var client:BillingClient?=null
    private var purchaseReply:Invoke?=null
    private fun validProduct(id:String)=Regex("^[a-z0-9][a-z0-9._-]{0,119}$").matches(id)

    private fun ready(invoke:Invoke,action:(BillingClient)->Unit) {
        activity.runOnUiThread {
            if(gate.destroyed){invoke.reject("billing_client_closed");return@runOnUiThread}
            if(client==null)client=BillingClient.newBuilder(activity)
                .setListener(this)
                .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().enablePrepaidPlans().build())
                .enableAutoServiceReconnection().build()
            val billing=client!!
            if(billing.isReady){action(billing);return@runOnUiThread}
            if(waiting.size>=8){invoke.reject("billing_busy");return@runOnUiThread}
            waiting.add(invoke to action)
            main.postDelayed({if(waiting.removeAll { it.first===invoke })invoke.reject("billing_connection_timeout")},15000)
            if(!gate.startConnection())return@runOnUiThread
            billing.startConnection(object:BillingClientStateListener {
                override fun onBillingSetupFinished(result:BillingResult) {
                    if(gate.destroyed)return
                    gate.connectionFinished()
                    val jobs=waiting.toList();waiting.clear()
                    for((call,run)in jobs)if(result.responseCode==BillingClient.BillingResponseCode.OK)run(billing) else call.reject("billing_unavailable")
                    if(result.responseCode==BillingClient.BillingResponseCode.OK)requery(billing){reply,purchases->
                        if(!gate.destroyed&&reply.responseCode==BillingClient.BillingResponseCode.OK)trigger("purchases",JSObject().put("status","updated").put("purchases",purchaseList(purchases)))
                    }
                }
                override fun onBillingServiceDisconnected(){gate.connectionFinished()}
            })
        }
    }

    private fun products(ids:List<String>)=QueryProductDetailsParams.newBuilder().setProductList(ids.map {
        QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(BillingClient.ProductType.SUBS).build()
    }).build()

    @Command fun queryProducts(invoke:Invoke) {
        val args=invoke.parseArgs(CatalogArgs::class.java)
        if(args.productIds.isEmpty()||args.productIds.size>20||args.productIds.any{!validProduct(it)}||args.basePlanIds.isEmpty()){invoke.reject("billing_invalid_catalog");return}
        ready(invoke){billing->billing.queryProductDetailsAsync(products(args.productIds)){result,details->
            if(gate.destroyed){invoke.reject("billing_client_closed");return@queryProductDetailsAsync}
            if(result.responseCode!=BillingClient.BillingResponseCode.OK){invoke.reject("billing_products_unavailable");return@queryProductDetailsAsync}
            val offers=JSONArray()
            for(product in details.productDetailsList)for(offer in product.subscriptionOfferDetails.orEmpty()) {
                if(offer.basePlanId !in args.basePlanIds || offer.offerId!=null)continue // Base monthly plan, no implicit trial/intro price.
                val phase=offer.pricingPhases.pricingPhaseList.lastOrNull()?:continue
                if(phase.billingPeriod!="P1M")continue
                offers.put(JSObject().put("productId",product.productId).put("title",product.title)
                    .put("basePlanId",offer.basePlanId).put("offerToken",offer.offerToken)
                    .put("formattedPrice",phase.formattedPrice).put("currency",phase.priceCurrencyCode))
            }
            invoke.resolve(JSObject().put("packageName",activity.packageName).put("offers",offers))
        }}
    }

    @Command fun purchase(invoke:Invoke) {
        val args=invoke.parseArgs(PurchaseArgs::class.java)
        if(!validProduct(args.productId)||args.offerToken.isBlank()||!Regex("^[a-f0-9]{64}$").matches(args.obfuscatedAccountId)){invoke.reject("billing_invalid_purchase");return}
        ready(invoke){billing->
            if(!gate.startPurchase()){invoke.reject("billing_purchase_in_progress");return@ready}
            purchaseReply=invoke
            billing.queryProductDetailsAsync(products(listOf(args.productId))){result,details->activity.runOnUiThread {
                if(gate.destroyed)return@runOnUiThread
                val product=details.productDetailsList.firstOrNull { it.productId==args.productId }
                val exists=product?.subscriptionOfferDetails?.any { it.offerToken==args.offerToken }==true
                if(result.responseCode!=BillingClient.BillingResponseCode.OK||product==null||!exists){finish("error");return@runOnUiThread}
                val params=BillingFlowParams.newBuilder().setObfuscatedAccountId(args.obfuscatedAccountId)
                    .setProductDetailsParamsList(listOf(BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(product).setOfferToken(args.offerToken).build())).build()
                val launched=billing.launchBillingFlow(activity,params)
                if(launched.responseCode!=BillingClient.BillingResponseCode.OK)finish(if(launched.responseCode==BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED)"owned" else "error")
            }}
        }
    }

    private fun purchaseList(values:List<Purchase>):JSONArray=JSONArray().apply {
        for(p in values)put(JSObject().put("purchaseToken",p.purchaseToken).put("productIds",JSONArray(p.products))
            .put("state",when(p.purchaseState){Purchase.PurchaseState.PURCHASED->"purchased";Purchase.PurchaseState.PENDING->"pending";else->"unknown"})
            .put("obfuscatedAccountId",p.accountIdentifiers?.obfuscatedAccountId).put("packageName",activity.packageName))
    }
    private fun finish(status:String,purchases:List<Purchase> = emptyList()) {
        val reply=purchaseReply;purchaseReply=null;gate.purchaseFinished()
        reply?.resolve(JSObject().put("status",status).put("purchases",purchaseList(purchases)))
    }
    override fun onPurchasesUpdated(result:BillingResult,purchases:MutableList<Purchase>?) {
        activity.runOnUiThread {
            if(gate.destroyed)return@runOnUiThread
            val status=when(result.responseCode){BillingClient.BillingResponseCode.OK->"updated";BillingClient.BillingResponseCode.USER_CANCELED->"canceled";BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED->"owned";else->"error"}
            finish(status,purchases.orEmpty())
            trigger("purchases",JSObject().put("status",status).put("purchases",purchaseList(purchases.orEmpty())))
        }
    }
    private fun requery(billing:BillingClient,callback:(BillingResult,List<Purchase>)->Unit) {
        val params=QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).includeSuspendedSubscriptions(true).build()
        billing.queryPurchasesAsync(params){result,purchases->callback(result,purchases)}
    }
    @Command fun queryPurchases(invoke:Invoke) {
        ready(invoke){billing->requery(billing){result,purchases->
            if(gate.destroyed)invoke.reject("billing_client_closed")
            else if(result.responseCode!=BillingClient.BillingResponseCode.OK)invoke.reject("billing_restore_unavailable")
            else invoke.resolve(JSObject().put("status","updated").put("purchases",purchaseList(purchases)))
        }}
    }
    override fun onResume() {
        val billing=client?:return
        if(!gate.destroyed&&!gate.connecting)requery(billing){result,purchases->
            if(!gate.destroyed&&result.responseCode==BillingClient.BillingResponseCode.OK)trigger("purchases",JSObject().put("status","updated").put("purchases",purchaseList(purchases)))
        }
    }
    override fun onDestroy(activity:androidx.appcompat.app.AppCompatActivity) {
        gate.destroy();for((invoke,_)in waiting)invoke.reject("billing_client_closed");waiting.clear()
        purchaseReply?.reject("billing_client_closed");purchaseReply=null;client?.endConnection();client=null
    }
    @Command fun manageSubscription(invoke:Invoke) {
        val args=invoke.parseArgs(ManagementArgs::class.java)
        if(!validProduct(args.productId)){invoke.reject("billing_invalid_product");return}
        val uri=Uri.Builder().scheme("https").authority("play.google.com").path("store/account/subscriptions")
            .appendQueryParameter("sku",args.productId).appendQueryParameter("package",activity.packageName).build()
        activity.runOnUiThread {
            try {
                try{activity.startActivity(Intent(Intent.ACTION_VIEW,uri).setPackage("com.android.vending"))}
                catch(_:ActivityNotFoundException){activity.startActivity(Intent(Intent.ACTION_VIEW,uri))}
                invoke.resolve(JSObject().put("opened",true))
            }catch(_:Exception){invoke.reject("billing_management_unavailable")}
        }
    }
}
