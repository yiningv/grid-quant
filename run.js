const express = require('express')
const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

const { runBet } = require('./data/runBetData')
const { cf, configJson, TA } = require('./app/binanceApi')
let listenPort = configJson.listenPort;
const { buy, buy_close, send_msg, msg_on, sell, sell_close } = require('./app/message')
let coinList = [];
let buyFlag = false;
let sellFlag = false;

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/**
 * 获取交易对的data.json基础信息
 * @param {*} cointype 交易对
 */
async function pre_data(cointype) {
    // 当前网格买入价格
    let grid_buy_price = runBet.get_buy_price(cointype);
    // 当前网格卖出价格
    let grid_sell_price = runBet.get_sell_price(cointype);
    // 买入量
    let quantity = runBet.get_quantity(cointype);
    // 当前步数
    let step = runBet.get_step(cointype);
    // 当前交易对市价
    let _cur_market_price = (await cf.price({ symbol: cointype })).data.price;
    let right_size = (_cur_market_price.split('.')[1]).length;
    let cur_market_price = Number(_cur_market_price);
    //多单 空单数量
    let acc = await cf.account();
    let posL = null;
    let posS = null;
    acc.data.positions.map(v => {
        if (Number(v.positionAmt) > 0 && v.symbol == cointype) {
            posL = v;
        }
        if (Number(v.positionAmt) < 0 && v.symbol == cointype) {
            posS = v;
        }
    });
    //获取boll
    let records = await cf.records(cointype, '1h')
    let boll = TA.BOLL(records, 32)
    let upLine = boll[0]
    let midLine = boll[1]
    let downLine = boll[2]
    let upL = upLine[upLine.length - 1]
    let midL = midLine[midLine.length - 1]
    let downL = downLine[downLine.length - 1];
    return [grid_buy_price, grid_sell_price, posL, posS, upL, midL, downL, quantity, step, cur_market_price, right_size]
}

async function loop_run() {
    try {
        while (true) {
            for (let i = 0; i < coinList.length; i++) {
                let coinType = coinList[i];
                let [grid_buy_price, grid_sell_price, posL, posS, upL, midL, downL, quantity, step, cur_market_price, right_size] = await pre_data(coinType);
                let doLongRate = 1;
                let doShortRate = 1;
                let minAmount = Number((10 / cur_market_price).toFixed(right_size))
                if (cur_market_price > midL) {
                    doLongRate = 2;
                } else {
                    doShortRate = 2;
                }
                if (cur_market_price <= grid_buy_price && !buyFlag && cur_market_price < upL && cur_market_price > downL) {
                    buyFlag = true;
                    if (configJson.isDoshort) {
                        //做空
                        if (posS != null) {
                            //减仓
                            let nowHave = -Number(posS.positionAmt);
                            let ams = Math.min(nowHave, quantity);
                            if (ams > minAmount) {
                                sell_close(coinType, ams, -1)
                                send_msg(`报警:币种为:${coinType}=>😁买入平空=>买单量为:${ams}=>😁买单价格为:${cur_market_price}`)
                            }
                        } else {
                            //开空
                            sell(coinType, quantity * doShortRate, -1)
                            send_msg(`报警:首次开仓,币种为:${coinType}=>😁卖出开空=>卖单量为:${quantity * doShortRate}=>😁卖单价格为:${cur_market_price}`)
                        }
                    }
                    let res = await buy(coinType, quantity * doLongRate, -1);
                    if (res.status == 200) {
                        send_msg(`报警:${posL == null ? '首次开仓' : '补仓'},币种为:${coinType}=>😁买入开多=>买单量为:${quantity * doLongRate}=>😁买单价格为:${cur_market_price}`)
                        runBet.set_ratio(coinType);
                        await sleep(500);
                        runBet.set_record_price(coinType, cur_market_price);
                        await sleep(500);
                        runBet.modify_price(coinType, cur_market_price, step + 1, cur_market_price);
                        await sleep(1000);
                        buyFlag = false;
                    } else {
                        buyFlag = false;
                        break;
                    }
                } else if (cur_market_price > grid_sell_price && !sellFlag && cur_market_price < upL && cur_market_price > downL) {
                    sellFlag = true;
                    if (step == 0) {
                        runBet.modify_price(coinType, grid_sell_price, step, cur_market_price);
                        sellFlag = false;
                    } else {
                        let last_price = runBet.get_record_price(coinType)
                        let sell_amount = runBet.get_quantity(coinType, false)
                        let porfit_usdt = ((cur_market_price - last_price) * sell_amount).toFixed(4);
                        if (configJson.isDoshort) {
                            //补仓
                            sell(coinType, quantity * doShortRate, -1)
                            send_msg(`报警:${posS == null ? '首次开仓' : '补仓'},币种为:${coinType}=>😁卖出开空=>卖单量为:${quantity * doShortRate}=>😁卖单价格为:${cur_market_price}`)
                        }
                        let nowHave = Number(posL.positionAmt);
                        let ams = Math.min(nowHave, sell_amount);
                        if (ams > minAmount) {
                            let res = await buy_close(coinType, ams, -1);
                            if (res.status == 200) {
                                send_msg(`报警:币种为:${coinType}=>😁卖出平多=>卖单量为:${ams}=>😁卖单价格为:${cur_market_price}=>😁预计盈利:${porfit_usdt}`)
                                runBet.set_ratio(coinType);//启动动态改变比率
                                await sleep(500)
                                runBet.modify_price(coinType, last_price, step - 1, cur_market_price)
                                await sleep(500)
                                runBet.remove_record_price(coinType)
                                await sleep(1000)  // 挂单后，停止运行1分钟
                                sellFlag = false;
                            } else {
                                sellFlag = false;
                                break;
                            }
                        }
                    }
                } else {
                    let s = new Date().getSeconds();
                    if (s % 30 == 0) {
                        console.log(`币种:${coinType},当前市价:${cur_market_price},吃:${grid_buy_price},吐:${grid_sell_price},步长:${step},数量:${quantity},继续运行...`)
                    }
                    await sleep(1000)
                }
            }
        }
    } catch (err) {
        send_msg(err.message)
        console.log('系统异常:', err)
    }
}

async function main() {
    runBet.init();
    msg_on()
    coinList = runBet.get_coinList();
    await loop_run()
}
// curl -H 'Content-Type: application/json; charset=utf-8' -d '{ "ticker": "ETHUSDT", "position": "long", "action": "buy", "price": 2896.21 }' -X POST http://127.0.0.1:30010/api/botmsg
app.post("/api/botmsg", function (req, res) {
    let data = { code: 200, message: 'ok' }
    try {
        let r = req.body
        send_msg(`OCC信号提醒:${JSON.stringify(r)}`)
        console.log(r)
        res.json(r);
    } catch (error) {
        console.log(error)
        data.code = -3;
        data.message = '系统异常'
        res.json(data)
    }
});
main()
//监听
app.listen(listenPort, () => {
    console.log(`本地服务监听:${listenPort}`)
})
