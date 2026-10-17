package ua.triptracker.tracker

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Дати в форматі, який чекає сервер (без залежності від java.time). */
object IsoDate {
    private val dateFmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    private val timeFmt = SimpleDateFormat("HH:mm", Locale.US)

    fun now(): String = dateFmt.format(Date())
    fun time(): String = timeFmt.format(Date())
}
